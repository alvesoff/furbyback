const express = require('express');
const { body, validationResult } = require('express-validator');
const QRCode = require('qrcode');
const crypto = require('crypto');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { auth, userRateLimit, logUserActivity } = require('../middleware/auth');

const router = express.Router();

// Aplicar autenticação a todas as rotas
router.use(auth);

// Configurações PIX
const PIX_CONFIG = {
  merchantId: process.env.PIX_MERCHANT_ID,
  merchantSecret: process.env.PIX_MERCHANT_SECRET,
  environment: process.env.PIX_ENVIRONMENT || 'sandbox',
  baseUrl: process.env.PIX_BASE_URL || 'https://api.sandbox.pix.com',
  companyKey: process.env.PIX_COMPANY_KEY,
  companyName: 'Furby Investimentos',
  companyDocument: '12345678000199'
};

// Função para gerar chave PIX aleatória
const generatePixKey = () => {
  return crypto.randomUUID();
};

// Função para gerar txId único
const generateTxId = () => {
  return 'FURBY' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
};

// Função para gerar payload PIX
const generatePixPayload = (amount, txId, description) => {
  const merchantName = PIX_CONFIG.companyName.padEnd(25).substring(0, 25);
  const merchantCity = 'SAO PAULO'.padEnd(15).substring(0, 15);
  const pixKey = PIX_CONFIG.companyKey;
  
  // Formato simplificado do payload PIX (EMV)
  const payload = [
    '00020101', // Payload Format Indicator
    '010212', // Point of Initiation Method
    '26' + (pixKey.length + 22).toString().padStart(2, '0') + '0014br.gov.bcb.pix01' + pixKey.length.toString().padStart(2, '0') + pixKey,
    '52040000', // Merchant Category Code
    '5303986', // Transaction Currency (BRL)
    '54' + amount.toFixed(2).length.toString().padStart(2, '0') + amount.toFixed(2),
    '5802BR', // Country Code
    '59' + merchantName.length.toString().padStart(2, '0') + merchantName,
    '60' + merchantCity.length.toString().padStart(2, '0') + merchantCity,
    '62' + (txId.length + 4).toString().padStart(2, '0') + '05' + txId.length.toString().padStart(2, '0') + txId
  ].join('');
  
  // Calcular CRC16
  const crc = calculateCRC16(payload + '6304');
  
  return payload + '6304' + crc;
};

// Função para calcular CRC16
const calculateCRC16 = (data) => {
  let crc = 0xFFFF;
  
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
    }
  }
  
  return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
};

// Função para gerar QR Code
const generateQRCode = async (payload) => {
  try {
    const qrCodeDataURL = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 256
    });
    
    return qrCodeDataURL;
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error);
    throw new Error('Erro ao gerar QR Code');
  }
};

// @route   POST /api/pix/deposit
// @desc    Criar depósito via PIX
// @access  Private
router.post('/deposit', [
  userRateLimit(5, 60 * 60 * 1000), // 5 depósitos por hora
  body('amount')
    .isFloat({ min: 1, max: 50000 })
    .withMessage('Valor deve estar entre R$ 1,00 e R$ 50.000,00')
], logUserActivity('create_pix_deposit'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { amount } = req.body;
    const user = req.user;
    
    // Gerar dados do PIX
    const txId = generateTxId();
    const pixPayload = generatePixPayload(amount, txId, `Depósito ${user.name}`);
    const qrCodeImage = await generateQRCode(pixPayload);
    
    // Criar transação
    const transaction = new Transaction({
      user: req.userId,
      type: 'deposit',
      method: 'pix',
      amount,
      description: 'Depósito via PIX',
      pix: {
        key: PIX_CONFIG.companyKey,
        keyType: 'random',
        qrCode: pixPayload,
        qrCodeImage,
        txId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000) // 30 minutos
      },
      status: 'pending'
    });
    
    await transaction.save();
    
    res.status(201).json({
      success: true,
      message: 'PIX gerado com sucesso',
      data: {
        transaction: transaction.toJSON(),
        pixData: {
          qrCode: pixPayload,
          qrCodeImage,
          txId,
          amount,
          expiresAt: transaction.pix.expiresAt,
          instructions: [
            'Abra o app do seu banco',
            'Escolha a opção PIX',
            'Escaneie o QR Code ou copie o código',
            'Confirme o pagamento',
            'O valor será creditado automaticamente'
          ]
        }
      }
    });

  } catch (error) {
    console.error('Erro ao criar depósito PIX:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   POST /api/pix/withdrawal
// @desc    Criar saque via PIX
// @access  Private
router.post('/withdrawal', [
  userRateLimit(3, 24 * 60 * 60 * 1000), // 3 saques por dia
  body('amount')
    .isFloat({ min: 10, max: 50000 })
    .withMessage('Valor deve estar entre R$ 10,00 e R$ 50.000,00'),
  
  body('pixKey')
    .notEmpty()
    .withMessage('Chave PIX é obrigatória')
    .trim(),
  
  body('pixKeyType')
    .isIn(['cpf', 'email', 'phone', 'random'])
    .withMessage('Tipo de chave PIX inválido'),
  
  body('password')
    .notEmpty()
    .withMessage('Senha é obrigatória para confirmar o saque')
], logUserActivity('create_pix_withdrawal'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { amount, pixKey, pixKeyType, password } = req.body;
    
    // Buscar usuário com senha
    const user = await User.findById(req.userId).select('+password');
    
    // Verificar senha
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Senha incorreta'
      });
    }
    
    // Verificar saldo
    if (user.balance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Saldo insuficiente'
      });
    }
    
    // Validar chave PIX
    const isValidPixKey = validatePixKey(pixKey, pixKeyType);
    if (!isValidPixKey) {
      return res.status(400).json({
        success: false,
        message: 'Chave PIX inválida'
      });
    }
    
    // Calcular taxa (exemplo: 1% ou mínimo R$ 2)
    const fee = Math.max(amount * 0.01, 2);
    const netAmount = amount - fee;
    
    // Criar transação
    const transaction = new Transaction({
      user: req.userId,
      type: 'withdrawal',
      method: 'pix',
      amount,
      fee,
      netAmount,
      description: 'Saque via PIX',
      pix: {
        key: pixKey,
        keyType,
        txId: generateTxId()
      },
      status: 'pending'
    });
    
    await transaction.save();
    
    // Processar saque (em produção, isso seria feito via webhook ou job)
    setTimeout(async () => {
      try {
        await processPixWithdrawal(transaction._id);
      } catch (error) {
        console.error('Erro ao processar saque PIX:', error);
      }
    }, 5000); // Simular processamento em 5 segundos
    
    res.status(201).json({
      success: true,
      message: 'Saque solicitado com sucesso',
      data: {
        transaction: transaction.toJSON(),
        estimatedTime: '5-10 minutos',
        fee,
        netAmount
      }
    });

  } catch (error) {
    console.error('Erro ao criar saque PIX:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/pix/transactions
// @desc    Listar transações PIX do usuário
// @access  Private
router.get('/transactions', logUserActivity('view_pix_transactions'), async (req, res) => {
  try {
    const { page = 1, limit = 10, type } = req.query;
    
    const query = {
      user: req.userId,
      method: 'pix'
    };
    
    if (type) {
      query.type = type;
    }
    
    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Transaction.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Erro ao listar transações PIX:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/pix/transaction/:id
// @desc    Obter detalhes de transação PIX
// @access  Private
router.get('/transaction/:id', async (req, res) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      user: req.userId,
      method: 'pix'
    });
    
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transação não encontrada'
      });
    }
    
    res.json({
      success: true,
      data: {
        transaction
      }
    });

  } catch (error) {
    console.error('Erro ao obter transação PIX:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   POST /api/pix/webhook
// @desc    Webhook para receber notificações PIX
// @access  Public (mas com validação de assinatura)
router.post('/webhook', async (req, res) => {
  try {
    // Validar assinatura do webhook (implementar conforme provedor)
    const signature = req.headers['x-pix-signature'];
    if (!validateWebhookSignature(req.body, signature)) {
      return res.status(401).json({
        success: false,
        message: 'Assinatura inválida'
      });
    }
    
    const { txId, status, amount, endToEndId } = req.body;
    
    // Buscar transação
    const transaction = await Transaction.findByPixTxId(txId);
    if (!transaction) {
      console.log('Transação não encontrada para txId:', txId);
      return res.status(404).json({
        success: false,
        message: 'Transação não encontrada'
      });
    }
    
    // Processar conforme status
    switch (status) {
      case 'PAID':
      case 'CONFIRMED':
        if (transaction.status === 'pending') {
          transaction.pix.endToEndId = endToEndId;
          await transaction.process();
          console.log('PIX confirmado:', txId);
        }
        break;
        
      case 'FAILED':
      case 'CANCELLED':
        if (transaction.status === 'pending' || transaction.status === 'processing') {
          await transaction.fail('Pagamento falhou ou foi cancelado');
          console.log('PIX falhou:', txId);
        }
        break;
    }
    
    res.json({ success: true });

  } catch (error) {
    console.error('Erro no webhook PIX:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// Funções auxiliares

// Validar chave PIX
const validatePixKey = (key, type) => {
  switch (type) {
    case 'cpf':
      return /^\d{11}$/.test(key.replace(/\D/g, ''));
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key);
    case 'phone':
      return /^\d{10,11}$/.test(key.replace(/\D/g, ''));
    case 'random':
      return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key);
    default:
      return false;
  }
};

// Validar assinatura do webhook
const validateWebhookSignature = (payload, signature) => {
  if (!signature || !PIX_CONFIG.merchantSecret) {
    return false;
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', PIX_CONFIG.merchantSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return signature === expectedSignature;
};

// Processar saque PIX
const processPixWithdrawal = async (transactionId) => {
  try {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction || transaction.status !== 'pending') {
      return;
    }
    
    // Simular processamento (em produção, fazer chamada para API do banco)
    const success = Math.random() > 0.1; // 90% de sucesso
    
    if (success) {
      transaction.pix.endToEndId = 'E' + Date.now() + crypto.randomBytes(8).toString('hex').toUpperCase();
      await transaction.process();
      console.log('Saque PIX processado com sucesso:', transaction.transactionId);
    } else {
      await transaction.fail('Falha no processamento do saque');
      console.log('Saque PIX falhou:', transaction.transactionId);
    }
    
  } catch (error) {
    console.error('Erro ao processar saque PIX:', error);
  }
};

module.exports = router;