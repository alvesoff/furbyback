const express = require('express');
const { body, validationResult, query } = require('express-validator');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Investment = require('../models/Investment');
const { auth, adminAuth, checkResourceOwnership, userRateLimit, logUserActivity } = require('../middleware/auth');

const router = express.Router();

// Aplicar autenticação a todas as rotas
router.use(auth);

// @route   GET /api/transactions
// @desc    Listar transações do usuário
// @access  Private
router.get('/', [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Página deve ser um número positivo'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limite deve estar entre 1 e 100'),
  
  query('type')
    .optional()
    .isIn(['deposit', 'withdrawal', 'investment', 'return', 'referral', 'bonus'])
    .withMessage('Tipo de transação inválido'),
  
  query('method')
    .optional()
    .isIn(['pix', 'bank_transfer', 'credit_card', 'system'])
    .withMessage('Método de pagamento inválido'),
  
  query('status')
    .optional()
    .isIn(['pending', 'processing', 'completed', 'failed', 'cancelled'])
    .withMessage('Status inválido'),
  
  query('startDate')
    .optional()
    .isISO8601()
    .withMessage('Data inicial inválida'),
  
  query('endDate')
    .optional()
    .isISO8601()
    .withMessage('Data final inválida')
], logUserActivity('view_transactions'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetros inválidos',
        errors: errors.array()
      });
    }

    const {
      page = 1,
      limit = 20,
      type,
      method,
      status,
      startDate,
      endDate
    } = req.query;
    
    // Construir query
    const query = { user: req.userId };
    
    if (type) query.type = type;
    if (method) query.method = method;
    if (status) query.status = status;
    
    // Filtro por data
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    // Buscar transações
    const transactions = await Transaction.find(query)
      .populate('investment', 'trader.name amount')
      .populate('referredUser', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Transaction.countDocuments(query);
    
    // Calcular totais por tipo
    const totals = await Transaction.aggregate([
      { $match: { ...query, status: 'completed' } },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$netAmount' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    const totalsByType = {};
    totals.forEach(item => {
      totalsByType[item._id] = {
        total: item.total,
        count: item.count
      };
    });
    
    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        },
        summary: {
          totalsByType,
          totalTransactions: total
        }
      }
    });

  } catch (error) {
    console.error('Erro ao listar transações:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/transactions/:id
// @desc    Obter transação específica
// @access  Private
router.get('/:id', checkResourceOwnership('Transaction'), logUserActivity('view_transaction'), async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id)
      .populate('user', 'name email')
      .populate('investment', 'trader.name amount status')
      .populate('referredUser', 'name email');
    
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
    console.error('Erro ao obter transação:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/transactions/stats/summary
// @desc    Obter estatísticas de transações
// @access  Private
router.get('/stats/summary', [
  query('period')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('Período deve estar entre 1 e 365 dias')
], logUserActivity('view_transaction_stats'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetros inválidos',
        errors: errors.array()
      });
    }

    const { period = 30 } = req.query;
    
    // Obter estatísticas
    const stats = await Transaction.getTransactionStats(req.userId, parseInt(period));
    
    // Calcular saldo atual
    const user = await User.findById(req.userId);
    
    // Transações recentes
    const recentTransactions = await Transaction.find({
      user: req.userId,
      status: 'completed'
    })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('investment', 'trader.name');
    
    // Evolução mensal (últimos 6 meses)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const monthlyEvolution = await Transaction.aggregate([
      {
        $match: {
          user: req.userId,
          status: 'completed',
          createdAt: { $gte: sixMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            type: '$type'
          },
          total: { $sum: '$netAmount' },
          count: { $sum: 1 }
        }
      },
      {
        $sort: {
          '_id.year': 1,
          '_id.month': 1
        }
      }
    ]);
    
    res.json({
      success: true,
      data: {
        currentBalance: user.balance,
        periodStats: stats,
        recentTransactions,
        monthlyEvolution,
        summary: {
          totalDeposits: user.balance + user.totalInvested,
          totalInvested: user.totalInvested,
          totalEarnings: user.totalEarnings,
          referralEarnings: user.referralEarnings
        }
      }
    });

  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/transactions/export
// @desc    Exportar transações (CSV)
// @access  Private
router.get('/export', [
  userRateLimit(3, 60 * 60 * 1000), // 3 exportações por hora
  query('format')
    .optional()
    .isIn(['csv', 'json'])
    .withMessage('Formato deve ser csv ou json'),
  
  query('startDate')
    .optional()
    .isISO8601()
    .withMessage('Data inicial inválida'),
  
  query('endDate')
    .optional()
    .isISO8601()
    .withMessage('Data final inválida')
], logUserActivity('export_transactions'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetros inválidos',
        errors: errors.array()
      });
    }

    const { format = 'csv', startDate, endDate } = req.query;
    
    // Construir query
    const query = { user: req.userId };
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    // Buscar transações
    const transactions = await Transaction.find(query)
      .populate('investment', 'trader.name')
      .sort({ createdAt: -1 })
      .limit(1000); // Limite para evitar sobrecarga
    
    if (format === 'csv') {
      // Gerar CSV
      const csvHeader = 'Data,Tipo,Método,Valor,Taxa,Valor Líquido,Status,Descrição\n';
      const csvRows = transactions.map(t => {
        const date = t.createdAt.toISOString().split('T')[0];
        const type = t.type;
        const method = t.method;
        const amount = t.amount.toFixed(2);
        const fee = t.fee.toFixed(2);
        const netAmount = t.netAmount.toFixed(2);
        const status = t.status;
        const description = t.description.replace(/,/g, ';'); // Escapar vírgulas
        
        return `${date},${type},${method},${amount},${fee},${netAmount},${status},"${description}"`;
      }).join('\n');
      
      const csv = csvHeader + csvRows;
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="transacoes.csv"');
      res.send(csv);
    } else {
      // Retornar JSON
      res.json({
        success: true,
        data: {
          transactions,
          exportedAt: new Date().toISOString(),
          totalRecords: transactions.length
        }
      });
    }

  } catch (error) {
    console.error('Erro ao exportar transações:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   PUT /api/transactions/:id/cancel
// @desc    Cancelar transação pendente
// @access  Private
router.put('/:id/cancel', [
  checkResourceOwnership('Transaction'),
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Motivo não pode ter mais de 200 caracteres')
], logUserActivity('cancel_transaction'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const transaction = req.resource;
    const { reason } = req.body;
    
    // Verificar se pode ser cancelada
    if (transaction.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Apenas transações pendentes podem ser canceladas'
      });
    }
    
    // Verificar se não expirou (para PIX)
    if (transaction.method === 'pix' && transaction.isPixExpired()) {
      return res.status(400).json({
        success: false,
        message: 'Transação PIX já expirou'
      });
    }
    
    // Cancelar transação
    await transaction.cancel(reason);
    
    res.json({
      success: true,
      message: 'Transação cancelada com sucesso',
      data: {
        transaction: transaction.toJSON()
      }
    });

  } catch (error) {
    console.error('Erro ao cancelar transação:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// Rotas administrativas

// @route   GET /api/transactions/admin/all
// @desc    Listar todas as transações (Admin)
// @access  Private/Admin
router.get('/admin/all', adminAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      type,
      method,
      status,
      user,
      startDate,
      endDate
    } = req.query;
    
    // Construir query
    const query = {};
    
    if (type) query.type = type;
    if (method) query.method = method;
    if (status) query.status = status;
    
    if (user) {
      const users = await User.find({
        $or: [
          { name: { $regex: user, $options: 'i' } },
          { email: { $regex: user, $options: 'i' } }
        ]
      }).select('_id');
      
      query.user = { $in: users.map(u => u._id) };
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    // Buscar transações
    const transactions = await Transaction.find(query)
      .populate('user', 'name email')
      .populate('investment', 'trader.name amount')
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
    console.error('Erro ao listar transações (admin):', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   PUT /api/transactions/admin/:id/status
// @desc    Alterar status de transação (Admin)
// @access  Private/Admin
router.put('/admin/:id/status', [
  adminAuth,
  body('status')
    .isIn(['pending', 'processing', 'completed', 'failed', 'cancelled'])
    .withMessage('Status inválido'),
  
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Motivo não pode ter mais de 200 caracteres')
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

    const { status, reason } = req.body;
    
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transação não encontrada'
      });
    }
    
    const oldStatus = transaction.status;
    
    // Atualizar status
    switch (status) {
      case 'completed':
        if (oldStatus === 'pending' || oldStatus === 'processing') {
          await transaction.process();
        }
        break;
        
      case 'failed':
        await transaction.fail(reason || 'Falha manual pelo administrador');
        break;
        
      case 'cancelled':
        await transaction.cancel(reason || 'Cancelado pelo administrador');
        break;
        
      default:
        transaction.status = status;
        if (reason) transaction.notes = reason;
        await transaction.save();
    }
    
    res.json({
      success: true,
      message: 'Status da transação atualizado com sucesso',
      data: {
        transaction: transaction.toJSON(),
        oldStatus,
        newStatus: transaction.status
      }
    });

  } catch (error) {
    console.error('Erro ao alterar status da transação:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/transactions/admin/stats
// @desc    Estatísticas gerais de transações (Admin)
// @access  Private/Admin
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const { period = 30 } = req.query;
    
    // Estatísticas gerais
    const generalStats = await Transaction.getTransactionStats(null, parseInt(period));
    
    // Transações por dia (últimos 30 dias)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const dailyStats = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: thirtyDaysAgo },
          status: 'completed'
        }
      },
      {
        $group: {
          _id: {
            date: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt'
              }
            },
            type: '$type'
          },
          total: { $sum: '$netAmount' },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.date': 1 }
      }
    ]);
    
    // Top usuários por volume
    const topUsers = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: thirtyDaysAgo },
          status: 'completed'
        }
      },
      {
        $group: {
          _id: '$user',
          totalVolume: { $sum: '$amount' },
          transactionCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $unwind: '$user'
      },
      {
        $project: {
          userName: '$user.name',
          userEmail: '$user.email',
          totalVolume: 1,
          transactionCount: 1
        }
      },
      {
        $sort: { totalVolume: -1 }
      },
      {
        $limit: 10
      }
    ]);
    
    res.json({
      success: true,
      data: {
        generalStats,
        dailyStats,
        topUsers,
        period: parseInt(period)
      }
    });

  } catch (error) {
    console.error('Erro ao obter estatísticas (admin):', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;