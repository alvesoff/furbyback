const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiting específico para autenticação
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // máximo 5 tentativas por IP
  message: {
    success: false,
    message: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
    code: 'AUTH_RATE_LIMIT'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Middleware de validação
const validateRegister = [
  body('name')
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Nome deve ter entre 3 e 100 caracteres')
    .matches(/^[a-zA-ZÀ-ÿ\s]+$/)
    .withMessage('Nome deve conter apenas letras e espaços'),
  
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Email inválido'),
  
  body('password')
    .isLength({ min: 6 })
    .withMessage('Senha deve ter pelo menos 6 caracteres')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número'),
  
  body('confirmPassword')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Confirmação de senha não confere');
      }
      return true;
    }),
  
  body('referralCode')
    .optional()
    .trim()
    .isLength({ min: 5, max: 20 })
    .withMessage('Código de indicação inválido')
];

const validateLogin = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Email inválido'),
  
  body('password')
    .notEmpty()
    .withMessage('Senha é obrigatória')
];

// Função para gerar JWT
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Função para gerar refresh token
const generateRefreshToken = (userId) => {
  return jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
};

// @route   POST /api/auth/register
// @desc    Registrar novo usuário
// @access  Public
router.post('/register', authLimiter, validateRegister, async (req, res) => {
  try {
    // Verificar erros de validação
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { name, email, password, referralCode } = req.body;

    // Verificar se usuário já existe
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email já cadastrado no sistema'
      });
    }

    // Verificar código de indicação se fornecido
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findByReferralCode(referralCode);
      if (!referrer) {
        return res.status(400).json({
          success: false,
          message: 'Código de indicação inválido'
        });
      }
      referredBy = referrer._id;
    }

    // Criar novo usuário
    const user = new User({
      name,
      email,
      password,
      referredBy
    });

    await user.save();

    // Gerar tokens
    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Atualizar último login
    await user.updateLastLogin();

    res.status(201).json({
      success: true,
      message: 'Usuário criado com sucesso',
      data: {
        user: user.toJSON(),
        token,
        refreshToken
      }
    });

  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login do usuário
// @access  Public
router.post('/login', authLimiter, validateLogin, async (req, res) => {
  try {
    // Verificar erros de validação
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Dados inválidos',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Buscar usuário com senha
    const user = await User.findOne({ email, isActive: true }).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Email ou senha incorretos'
      });
    }

    // Verificar senha
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Email ou senha incorretos'
      });
    }

    // Gerar tokens
    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Atualizar último login
    await user.updateLastLogin();

    res.json({
      success: true,
      message: 'Login realizado com sucesso',
      data: {
        user: user.toJSON(),
        token,
        refreshToken
      }
    });

  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   POST /api/auth/refresh
// @desc    Renovar token de acesso
// @access  Public
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token é obrigatório'
      });
    }

    // Verificar refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    
    if (decoded.type !== 'refresh') {
      return res.status(401).json({
        success: false,
        message: 'Token inválido'
      });
    }

    // Buscar usuário
    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não encontrado ou inativo'
      });
    }

    // Gerar novo token de acesso
    const newToken = generateToken(user._id);

    res.json({
      success: true,
      message: 'Token renovado com sucesso',
      data: {
        token: newToken
      }
    });

  } catch (error) {
    console.error('Erro ao renovar token:', error);
    res.status(401).json({
      success: false,
      message: 'Token inválido ou expirado'
    });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout do usuário
// @access  Private
router.post('/logout', async (req, res) => {
  try {
    // Em uma implementação completa, você adicionaria o token a uma blacklist
    res.json({
      success: true,
      message: 'Logout realizado com sucesso'
    });
  } catch (error) {
    console.error('Erro no logout:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   GET /api/auth/me
// @desc    Obter dados do usuário logado
// @access  Private
router.get('/me', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token de acesso é obrigatório'
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Buscar usuário
    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não encontrado ou inativo'
      });
    }

    // Obter estatísticas do usuário
    const userStats = await User.getUserStats(user._id);

    res.json({
      success: true,
      data: userStats
    });

  } catch (error) {
    console.error('Erro ao obter dados do usuário:', error);
    res.status(401).json({
      success: false,
      message: 'Token inválido ou expirado'
    });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Solicitar redefinição de senha
// @access  Public
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail().withMessage('Email inválido')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Email inválido',
        errors: errors.array()
      });
    }

    const { email } = req.body;

    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      // Por segurança, sempre retornar sucesso mesmo se o email não existir
      return res.json({
        success: true,
        message: 'Se o email existir, você receberá instruções para redefinir sua senha'
      });
    }

    // Gerar token de redefinição
    const resetToken = jwt.sign(
      { userId: user._id, type: 'password_reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
    await user.save();

    // TODO: Enviar email com link de redefinição
    // await sendPasswordResetEmail(user.email, resetToken);

    res.json({
      success: true,
      message: 'Se o email existir, você receberá instruções para redefinir sua senha'
    });

  } catch (error) {
    console.error('Erro ao solicitar redefinição de senha:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor'
    });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Redefinir senha
// @access  Public
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Token é obrigatório'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Senha deve ter pelo menos 6 caracteres')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número')
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

    const { token, password } = req.body;

    // Verificar token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.type !== 'password_reset') {
      return res.status(400).json({
        success: false,
        message: 'Token inválido'
      });
    }

    // Buscar usuário
    const user = await User.findOne({
      _id: decoded.userId,
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() },
      isActive: true
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Token inválido ou expirado'
      });
    }

    // Atualizar senha
    user.password = password;
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await user.save();

    res.json({
      success: true,
      message: 'Senha redefinida com sucesso'
    });

  } catch (error) {
    console.error('Erro ao redefinir senha:', error);
    res.status(400).json({
      success: false,
      message: 'Token inválido ou expirado'
    });
  }
});

module.exports = router;