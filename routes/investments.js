const express = require('express');
const { body, validationResult } = require('express-validator');
const Investment = require('../models/Investment');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth, adminAuth, checkResourceOwnership, userRateLimit, logUserActivity } = require('../middleware/auth');

const router = express.Router();

// Aplicar autenticação a todas as rotas
router.use(auth);

// Traders disponíveis (em produção, isso viria de um banco de dados)
const availableTraders = [
  {
    id: 'trader_1',
    name: 'Carlos Silva',
    avatar: '/img/traders/carlos.jpg',
    successRate: 85.5,
    period: '30 dias',
    periodInDays: 30,
    minInvestment: 100,
    maxInvestment: 10000,
    description: 'Especialista em day trade com foco em ações de tecnologia'
  },
  {
    id: 'trader_2',
    name: 'Ana Costa',
    avatar: '/img/traders/ana.jpg',
    successRate: 92.3,
    period: '45 dias',
    periodInDays: 45,
    minInvestment: 500,
    maxInvestment: 25000,
    description: 'Expert em forex e commodities com 10 anos de experiência'
  },
  {
    id: 'trader_3',
    name: 'Roberto Santos',
    avatar: '/img/traders/roberto.jpg',
    successRate: 78.9,
    period: '60 dias',
    periodInDays: 60,
    minInvestment: 200,
    maxInvestment: 15000,
    description: 'Especialista em criptomoedas e ativos digitais'
  },
  {
    id: 'trader_4',
    name: 'Marina Oliveira',
    avatar: '/img/traders/marina.jpg',
    successRate: 88.7,
    period: '90 dias',
    periodInDays: 90,
    minInvestment: 1000,
    maxInvestment: 50000,
    description: 'Gestora de fundos com foco em investimentos de longo prazo'
  }
];

// @route   GET /api/investments/traders
// @desc    Listar traders disponíveis
// @access  Private
router.get('/traders', logUserActivity('view_traders'), async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        traders: availableTraders
      }
    });
  } catch (error) {
    console.error('Erro ao listar traders:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   POST /api/investments
// @desc    Criar novo investimento
// @access  Private
router.post('/', [
  userRateLimit(10, 60 * 60 * 1000), // 10 investimentos por hora
  body('traderId')
    .notEmpty()
    .withMessage('ID do trader é obrigatório')
    .custom((value) => {
      const trader = availableTraders.find(t => t.id === value);
      if (!trader) {
        throw new Error('Trader não encontrado');
      }
      return true;
    }),
  
  body('amount')
    .isFloat({ min: 1 })
    .withMessage('Valor do investimento deve ser maior que R$ 1')
    .custom((value, { req }) => {
      const trader = availableTraders.find(t => t.id === req.body.traderId);
      if (trader) {
        if (value < trader.minInvestment) {
          throw new Error(`Valor mínimo para este trader é R$ ${trader.minInvestment}`);
        }
        if (value > trader.maxInvestment) {
          throw new Error(`Valor máximo para este trader é R$ ${trader.maxInvestment}`);
        }
      }
      return true;
    })
], logUserActivity('create_investment'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { traderId, amount } = req.body;
    const user = req.user;
    
    // Verificar se usuário tem saldo suficiente
    if (user.balance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Saldo insuficiente'
      });
    }
    
    // Buscar dados do trader
    const trader = availableTraders.find(t => t.id === traderId);
    
    // Criar investimento
    const investment = new Investment({
      user: req.userId,
      trader: {
        name: trader.name,
        avatar: trader.avatar,
        successRate: trader.successRate,
        period: trader.period,
        periodInDays: trader.periodInDays,
        minInvestment: trader.minInvestment,
        maxInvestment: trader.maxInvestment
      },
      amount,
      status: 'pending'
    });
    
    await investment.save();
    
    // Criar transação
    const transaction = new Transaction({
      user: req.userId,
      type: 'investment',
      method: 'system',
      amount,
      description: `Investimento com ${trader.name}`,
      investment: investment._id,
      status: 'pending'
    });
    
    await transaction.save();
    
    // Processar transação
    await transaction.process();
    
    // Ativar investimento
    investment.status = 'active';
    await investment.save();
    
    res.status(201).json({
      success: true,
      message: 'Investimento criado com sucesso',
      data: {
        investment: investment.toJSON(),
        transaction: transaction.toJSON()
      }
    });

  } catch (error) {
    console.error('Erro ao criar investimento:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/investments
// @desc    Listar investimentos do usuário
// @access  Private
router.get('/', logUserActivity('view_investments'), async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    
    const query = { user: req.userId };
    
    if (status) {
      query.status = status;
    }
    
    const investments = await Investment.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Investment.countDocuments(query);
    
    // Calcular progresso para investimentos ativos
    const investmentsWithProgress = investments.map(investment => {
      const investmentObj = investment.toJSON();
      if (investment.status === 'active') {
        investmentObj.progress = investment.calculateProgress();
      }
      return investmentObj;
    });
    
    res.json({
      success: true,
      data: {
        investments: investmentsWithProgress,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Erro ao listar investimentos:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/investments/:id
// @desc    Obter investimento específico
// @access  Private
router.get('/:id', checkResourceOwnership('Investment'), logUserActivity('view_investment'), async (req, res) => {
  try {
    const investment = req.resource;
    
    // Calcular progresso se ativo
    const investmentData = investment.toJSON();
    if (investment.status === 'active') {
      investmentData.progress = investment.calculateProgress();
    }
    
    // Buscar transações relacionadas
    const transactions = await Transaction.find({
      $or: [
        { investment: investment._id },
        { user: req.userId, type: 'return', description: { $regex: investment.trader.name } }
      ]
    }).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: {
        investment: investmentData,
        transactions
      }
    });

  } catch (error) {
    console.error('Erro ao obter investimento:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   PUT /api/investments/:id/cancel
// @desc    Cancelar investimento
// @access  Private
router.put('/:id/cancel', [
  checkResourceOwnership('Investment'),
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Motivo não pode ter mais de 200 caracteres')
], logUserActivity('cancel_investment'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const investment = req.resource;
    const { reason } = req.body;
    
    // Verificar se pode ser cancelado
    if (investment.status !== 'pending' && investment.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Investimento não pode ser cancelado'
      });
    }
    
    // Cancelar investimento
    await investment.cancel(reason);
    
    res.json({
      success: true,
      message: 'Investimento cancelado com sucesso',
      data: {
        investment: investment.toJSON()
      }
    });

  } catch (error) {
    console.error('Erro ao cancelar investimento:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/investments/stats/summary
// @desc    Obter estatísticas de investimentos
// @access  Private
router.get('/stats/summary', logUserActivity('view_investment_stats'), async (req, res) => {
  try {
    const stats = await Investment.getInvestmentStats(req.userId);
    
    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// Rotas administrativas

// @route   GET /api/investments/admin/all
// @desc    Listar todos os investimentos (Admin)
// @access  Private/Admin
router.get('/admin/all', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, trader, user } = req.query;
    
    const query = {};
    
    if (status) {
      query.status = status;
    }
    
    if (trader) {
      query['trader.name'] = { $regex: trader, $options: 'i' };
    }
    
    if (user) {
      const users = await User.find({
        $or: [
          { name: { $regex: user, $options: 'i' } },
          { email: { $regex: user, $options: 'i' } }
        ]
      }).select('_id');
      
      query.user = { $in: users.map(u => u._id) };
    }
    
    const investments = await Investment.find(query)
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Investment.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        investments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Erro ao listar investimentos (admin):', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   PUT /api/investments/admin/:id/complete
// @desc    Completar investimento manualmente (Admin)
// @access  Private/Admin
router.put('/admin/:id/complete', [
  adminAuth,
  body('actualReturn')
    .isFloat({ min: 0 })
    .withMessage('Retorno real deve ser um número positivo')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { actualReturn } = req.body;
    
    const investment = await Investment.findById(req.params.id);
    if (!investment) {
      return res.status(404).json({
        success: false,
        message: 'Investimento não encontrado'
      });
    }
    
    if (investment.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Apenas investimentos ativos podem ser completados'
      });
    }
    
    // Definir retorno real
    investment.actualReturn = actualReturn;
    
    // Completar investimento
    await investment.complete();
    
    // Criar transação de retorno
    const transaction = new Transaction({
      user: investment.user,
      type: 'return',
      method: 'system',
      amount: actualReturn,
      description: `Retorno do investimento com ${investment.trader.name}`,
      investment: investment._id,
      status: 'completed'
    });
    
    await transaction.save();
    
    res.json({
      success: true,
      message: 'Investimento completado com sucesso',
      data: {
        investment: investment.toJSON(),
        transaction: transaction.toJSON()
      }
    });

  } catch (error) {
    console.error('Erro ao completar investimento:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   POST /api/investments/admin/:id/daily-return
// @desc    Adicionar retorno diário (Admin)
// @access  Private/Admin
router.post('/admin/:id/daily-return', [
  adminAuth,
  body('amount')
    .isFloat({ min: 0 })
    .withMessage('Valor deve ser um número positivo'),
  
  body('percentage')
    .isFloat({ min: 0 })
    .withMessage('Porcentagem deve ser um número positivo')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { amount, percentage } = req.body;
    
    const investment = await Investment.findById(req.params.id);
    if (!investment) {
      return res.status(404).json({
        success: false,
        message: 'Investimento não encontrado'
      });
    }
    
    if (investment.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Apenas investimentos ativos podem receber retornos diários'
      });
    }
    
    // Adicionar retorno diário
    await investment.addDailyReturn(amount, percentage);
    
    res.json({
      success: true,
      message: 'Retorno diário adicionado com sucesso',
      data: {
        investment: investment.toJSON()
      }
    });

  } catch (error) {
    console.error('Erro ao adicionar retorno diário:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;