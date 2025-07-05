const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const QRCode = require('qrcode');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');

// Configurações ASAAS
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_BASE_URL || 'https://sandbox.asaas.com/api/v3';
const COMPANY_PIX_KEY = process.env.COMPANY_PIX_KEY;

// Headers padrão para requisições ASAAS
const getAsaasHeaders = () => ({
  'Content-Type': 'application/json',
  'access_token': ASAAS_API_KEY
});

// Função para gerar ID único
const generateUniqueId = () => {
  return crypto.randomBytes(16).toString('hex');
};

// Função para validar chave PIX
const isValidPixKey = (key) => {
  if (!key) return false;
  
  // CPF (11 dígitos)
  if (/^\d{11}$/.test(key)) return true;
  
  // CNPJ (14 dígitos)
  if (/^\d{14}$/.test(key)) return true;
  
  // Email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return true;
  
  // Telefone (+5511999999999)
  if (/^\+55\d{10,11}$/.test(key)) return true;
  
  // Chave aleatória (UUID)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return true;
  
  return false;
};

// 1. CRIAR COBRANÇA PIX (Depósito)
router.post('/deposit', auth, async (req, res) => {
  try {
    const { amount, description } = req.body;
    const userId = req.user.id;

    // Validações
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valor inválido' });
    }

    if (amount < 1) {
      return res.status(400).json({ error: 'Valor mínimo é R$ 1,00' });
    }

    if (amount > 50000) {
      return res.status(400).json({ error: 'Valor máximo é R$ 50.000,00' });
    }

    // Buscar usuário
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Criar cobrança no ASAAS
    const pixData = {
      customer: {
        name: user.name,
        email: user.email,
        cpfCnpj: user.cpf || '12345678901', // CPF padrão para sandbox
        phone: user.phone || '11999999999'
      },
      billingType: 'PIX',
      value: amount,
      dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 24h
      description: description || `Depósito Furby Investimentos - ${user.name}`,
      externalReference: generateUniqueId(),
      pixAddressKey: COMPANY_PIX_KEY
    };

    const response = await axios.post(
      `${ASAAS_BASE_URL}/payments`,
      pixData,
      { headers: getAsaasHeaders() }
    );

    const payment = response.data;

    // Gerar QR Code PIX
    let qrCodeData = null;
    let pixCopyPaste = null;

    if (payment.pixTransaction) {
      pixCopyPaste = payment.pixTransaction.payload;
      qrCodeData = await QRCode.toDataURL(pixCopyPaste);
    }

    // Salvar transação no banco
    const transaction = new Transaction({
      userId,
      type: 'deposit',
      method: 'pix',
      amount,
      status: 'pending',
      description: description || 'Depósito via PIX',
      pixData: {
        asaasPaymentId: payment.id,
        pixKey: COMPANY_PIX_KEY,
        qrCode: qrCodeData,
        copyPaste: pixCopyPaste,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      },
      metadata: {
        provider: 'asaas',
        externalReference: pixData.externalReference
      }
    });

    await transaction.save();

    res.json({
      success: true,
      transaction: {
        id: transaction._id,
        amount,
        status: 'pending',
        pixData: {
          qrCode: qrCodeData,
          copyPaste: pixCopyPaste,
          expiresAt: transaction.pixData.expiresAt
        }
      }
    });

  } catch (error) {
    console.error('Erro ao criar depósito PIX ASAAS:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.response?.data?.errors || error.message
    });
  }
});

// 2. SOLICITAR SAQUE PIX
router.post('/withdraw', auth, async (req, res) => {
  try {
    const { amount, pixKey, password } = req.body;
    const userId = req.user.id;

    // Validações
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valor inválido' });
    }

    if (!pixKey || !isValidPixKey(pixKey)) {
      return res.status(400).json({ error: 'Chave PIX inválida' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Senha é obrigatória' });
    }

    // Buscar usuário e verificar senha
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Senha incorreta' });
    }

    // Verificar saldo
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    // Valor mínimo e máximo
    if (amount < 10) {
      return res.status(400).json({ error: 'Valor mínimo para saque é R$ 10,00' });
    }

    if (amount > 10000) {
      return res.status(400).json({ error: 'Valor máximo para saque é R$ 10.000,00' });
    }

    // Criar transferência PIX no ASAAS
    const transferData = {
      value: amount,
      pixAddressKey: pixKey,
      description: `Saque Furby Investimentos - ${user.name}`,
      scheduleDate: new Date().toISOString().split('T')[0]
    };

    const response = await axios.post(
      `${ASAAS_BASE_URL}/transfers`,
      transferData,
      { headers: getAsaasHeaders() }
    );

    const transfer = response.data;

    // Debitar do saldo do usuário
    user.balance -= amount;
    await user.save();

    // Salvar transação
    const transaction = new Transaction({
      userId,
      type: 'withdrawal',
      method: 'pix',
      amount,
      status: 'processing',
      description: 'Saque via PIX',
      pixData: {
        asaasTransferId: transfer.id,
        pixKey,
        transferStatus: transfer.status
      },
      metadata: {
        provider: 'asaas'
      }
    });

    await transaction.save();

    res.json({
      success: true,
      transaction: {
        id: transaction._id,
        amount,
        status: 'processing',
        pixKey,
        estimatedTime: '5-10 minutos'
      }
    });

  } catch (error) {
    console.error('Erro ao criar saque PIX ASAAS:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.response?.data?.errors || error.message
    });
  }
});

// 3. WEBHOOK ASAAS
router.post('/webhook', async (req, res) => {
  try {
    const { event, payment } = req.body;

    console.log('Webhook ASAAS recebido:', { event, paymentId: payment?.id });

    if (event === 'PAYMENT_RECEIVED' && payment) {
      // Buscar transação pelo ID do pagamento ASAAS
      const transaction = await Transaction.findOne({
        'pixData.asaasPaymentId': payment.id,
        status: 'pending'
      });

      if (transaction) {
        // Atualizar status da transação
        transaction.status = 'completed';
        transaction.completedAt = new Date();
        await transaction.save();

        // Creditar valor na conta do usuário
        const user = await User.findById(transaction.userId);
        if (user) {
          user.balance += transaction.amount;
          await user.save();

          // Processar comissão de indicação se houver
          if (user.referredBy) {
            const referrer = await User.findById(user.referredBy);
            if (referrer) {
              const commission = transaction.amount * 0.02; // 2% de comissão
              referrer.balance += commission;
              await referrer.save();

              // Salvar transação de comissão
              const commissionTransaction = new Transaction({
                userId: referrer._id,
                type: 'commission',
                method: 'referral',
                amount: commission,
                status: 'completed',
                description: `Comissão de indicação - ${user.name}`,
                metadata: {
                  referredUserId: user._id,
                  originalTransactionId: transaction._id
                }
              });
              await commissionTransaction.save();
            }
          }

          console.log(`Pagamento processado: R$ ${transaction.amount} para usuário ${user.email}`);
        }
      }
    }

    res.status(200).json({ received: true });

  } catch (error) {
    console.error('Erro no webhook ASAAS:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// 4. LISTAR TRANSAÇÕES PIX
router.get('/transactions', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10, status } = req.query;

    const query = {
      userId,
      method: 'pix'
    };

    if (status) {
      query.status = status;
    }

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .select('-pixData.qrCode'); // Não retornar QR Code na listagem

    const total = await Transaction.countDocuments(query);

    res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Erro ao listar transações PIX:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// 5. OBTER DETALHES DE UMA TRANSAÇÃO PIX
router.get('/transaction/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findOne({
      _id: id,
      userId,
      method: 'pix'
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transação não encontrada' });
    }

    res.json({ transaction });

  } catch (error) {
    console.error('Erro ao obter transação PIX:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// 6. VERIFICAR STATUS DE PAGAMENTO ASAAS
router.get('/payment/:asaasId/status', auth, async (req, res) => {
  try {
    const { asaasId } = req.params;

    const response = await axios.get(
      `${ASAAS_BASE_URL}/payments/${asaasId}`,
      { headers: getAsaasHeaders() }
    );

    const payment = response.data;

    res.json({
      id: payment.id,
      status: payment.status,
      value: payment.value,
      dateCreated: payment.dateCreated,
      paymentDate: payment.paymentDate
    });

  } catch (error) {
    console.error('Erro ao verificar status do pagamento ASAAS:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;