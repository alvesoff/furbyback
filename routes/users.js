const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Investment = require('../models/Investment');
const { auth, adminAuth, userRateLimit, logUserActivity } = require('../middleware/auth');

const router = express.Router();

// Aplicar autenticação a todas as rotas
router.use(auth);

// @route   GET /api/users/profile
// @desc    Obter perfil do usuário logado
// @access  Private
router.get('/profile', logUserActivity('view_profile'), async (req, res) => {
  try {
    const userStats = await User.getUserStats(req.userId);
    
    res.json({
      success: true,
      data: userStats
    });
  } catch (error) {
    console.error('Erro ao obter perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   PUT /api/users/profile
// @desc    Atualizar perfil do usuário
// @access  Private
router.put('/profile', [
  userRateLimit(10, 15 * 60 * 1000), // 10 atualizações por 15 minutos
  body('name')
    .optional()
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Nome deve ter entre 3 e 100 caracteres')
    .matches(/^[a-zA-ZÀ-ÿ\s]+$/)
    .withMessage('Nome deve conter apenas letras e espaços'),
  
  body('pixKey')
    .optional()
    .trim()
    .custom((value, { req }) => {
      if (!value) return true;
      
      const { pixKeyType } = req.body;
      if (!pixKeyType) {
        throw new Error('Tipo da chave PIX é obrigatório quando chave PIX é fornecida');
      }
      
      switch (pixKeyType) {
        case 'cpf':
          if (!/^\d{11}$/.test(value.replace(/\D/g, ''))) {
            throw new Error('CPF inválido');
          }
          break;
        case 'email':
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            throw new Error('Email inválido');
          }
          break;
        case 'phone':
          if (!/^\d{10,11}$/.test(value.replace(/\D/g, ''))) {
            throw new Error('Telefone inválido');
          }
          break;
        case 'random':
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
            throw new Error('Chave aleatória inválida');
          }
          break;
        default:
          throw new Error('Tipo de chave PIX inválido');
      }
      
      return true;
    }),
  
  body('pixKeyType')
    .optional()
    .isIn(['cpf', 'email', 'phone', 'random'])
    .withMessage('Tipo de chave PIX inválido')
], logUserActivity('update_profile'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { name, pixKey, pixKeyType } = req.body;
    const user = req.user;

    // Atualizar campos permitidos
    if (name !== undefined) user.name = name;
    if (pixKey !== undefined) {
      user.pixKey = pixKey || null;
      user.pixKeyType = pixKey ? pixKeyType : null;
    }

    await user.save();

    res.json({
      success: true,
      message: 'Perfil atualizado com sucesso',
      data: {
        user: user.toJSON()
      }
    });

  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   PUT /api/users/password
// @desc    Alterar senha do usuário
// @access  Private
router.put('/password', [
  userRateLimit(5, 60 * 60 * 1000), // 5 alterações por hora
  body('currentPassword')
    .notEmpty()
    .withMessage('Senha atual é obrigatória'),
  
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('Nova senha deve ter pelo menos 6 caracteres')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Nova senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número'),
  
  body('confirmPassword')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Confirmação de senha não confere');
      }
      return true;
    })
], logUserActivity('change_password'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { currentPassword, newPassword } = req.body;
    
    // Buscar usuário com senha
    const user = await User.findById(req.userId).select('+password');
    
    // Verificar senha atual
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Senha atual incorreta'
      });
    }

    // Atualizar senha
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Senha alterada com sucesso'
    });

  } catch (error) {
    console.error('Erro ao alterar senha:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/users/dashboard
// @desc    Obter dados do dashboard
// @access  Private
router.get('/dashboard', logUserActivity('view_dashboard'), async (req, res) => {
  try {
    const userId = req.userId;
    
    // Buscar dados em paralelo
    const [userStats, recentTransactions, activeInvestments, investmentStats] = await Promise.all([
      User.getUserStats(userId),
      Transaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('investment', 'trader.name'),
      Investment.find({ user: userId, status: 'active' })
        .sort({ createdAt: -1 })
        .limit(3),
      Investment.getInvestmentStats(userId)
    ]);

    // Calcular progresso dos investimentos ativos
    const investmentsWithProgress = activeInvestments.map(investment => {
      const progress = investment.calculateProgress();
      return {
        ...investment.toJSON(),
        progress
      };
    });

    res.json({
      success: true,
      data: {
        user: userStats.user,
        stats: userStats.stats,
        recentTransactions,
        activeInvestments: investmentsWithProgress,
        investmentStats
      }
    });

  } catch (error) {
    console.error('Erro ao obter dados do dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/users/referrals
// @desc    Obter dados de indicações
// @access  Private
router.get('/referrals', logUserActivity('view_referrals'), async (req, res) => {
  try {
    const userId = req.userId;
    const user = req.user;
    
    // Buscar usuários indicados
    const referrals = await User.find({ referredBy: userId })
      .select('name email createdAt totalInvested')
      .sort({ createdAt: -1 });
    
    // Calcular estatísticas de indicação
    const totalReferrals = referrals.length;
    const totalReferralInvestments = referrals.reduce((sum, ref) => sum + ref.totalInvested, 0);
    
    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        referralEarnings: user.referralEarnings,
        totalReferrals,
        totalReferralInvestments,
        referrals: referrals.map(ref => ({
          id: ref._id,
          name: ref.name,
          email: ref.email.replace(/(.{2}).*(@.*)/, '$1***$2'), // Mascarar email
          joinedAt: ref.createdAt,
          totalInvested: ref.totalInvested
        }))
      }
    });

  } catch (error) {
    console.error('Erro ao obter dados de indicações:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   DELETE /api/users/account
// @desc    Desativar conta do usuário
// @access  Private
router.delete('/account', [
  userRateLimit(1, 24 * 60 * 60 * 1000), // 1 tentativa por dia
  body('password')
    .notEmpty()
    .withMessage('Senha é obrigatória para desativar a conta'),
  
  body('confirmation')
    .equals('DESATIVAR')
    .withMessage('Digite "DESATIVAR" para confirmar')
], logUserActivity('deactivate_account'), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { password } = req.body;
    
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

    // Verificar se há investimentos ativos
    const activeInvestments = await Investment.countDocuments({
      user: req.userId,
      status: 'active'
    });
    
    if (activeInvestments > 0) {
      return res.status(400).json({
        success: false,
        message: 'Não é possível desativar a conta com investimentos ativos'
      });
    }

    // Verificar se há saldo
    if (user.balance > 0) {
      return res.status(400).json({
        success: false,
        message: 'Não é possível desativar a conta com saldo disponível. Realize um saque primeiro.'
      });
    }

    // Desativar conta
    user.isActive = false;
    await user.save();

    res.json({
      success: true,
      message: 'Conta desativada com sucesso'
    });

  } catch (error) {
    console.error('Erro ao desativar conta:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// Rotas administrativas

// @route   GET /api/users
// @desc    Listar todos os usuários (Admin)
// @access  Private/Admin
router.get('/', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    
    const query = {};
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (status) {
      query.isActive = status === 'active';
    }
    
    const users = await User.find(query)
      .select('-password -passwordResetToken -emailVerificationToken')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await User.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/users/:id
// @desc    Obter usuário específico (Admin)
// @access  Private/Admin
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const userStats = await User.getUserStats(req.params.id);
    
    if (!userStats) {
      return res.status(404).json({
        success: false,
        message: 'Usuário não encontrado'
      });
    }
    
    res.json({
      success: true,
      data: userStats
    });

  } catch (error) {
    console.error('Erro ao obter usuário:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   PUT /api/users/:id/status
// @desc    Alterar status do usuário (Admin)
// @access  Private/Admin
router.put('/:id/status', [
  adminAuth,
  body('isActive')
    .isBoolean()
    .withMessage('Status deve ser verdadeiro ou falso')
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

    const { isActive } = req.body;
    
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuário não encontrado'
      });
    }

    user.isActive = isActive;
    await user.save();

    res.json({
      success: true,
      message: `Usuário ${isActive ? 'ativado' : 'desativado'} com sucesso`,
      data: {
        user: user.toJSON()
      }
    });

  } catch (error) {
    console.error('Erro ao alterar status do usuário:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;