const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Middleware para verificar autenticação
const auth = async (req, res, next) => {
  try {
    // Obter token do header
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token de acesso é obrigatório',
        code: 'NO_TOKEN'
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verificar se é um token de acesso (não refresh)
    if (decoded.type === 'refresh') {
      return res.status(401).json({
        success: false,
        message: 'Token inválido. Use um token de acesso.',
        code: 'INVALID_TOKEN_TYPE'
      });
    }
    
    // Buscar usuário
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não encontrado',
        code: 'USER_NOT_FOUND'
      });
    }
    
    // Verificar se usuário está ativo
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Conta desativada',
        code: 'ACCOUNT_DISABLED'
      });
    }
    
    // Adicionar usuário ao request
    req.user = user;
    req.userId = user._id;
    
    next();
    
  } catch (error) {
    console.error('Erro na autenticação:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Token inválido',
        code: 'INVALID_TOKEN'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expirado',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
};

// Middleware para verificar se é admin
const adminAuth = async (req, res, next) => {
  try {
    // Primeiro verificar autenticação normal
    await auth(req, res, () => {});
    
    // Verificar se é admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Acesso negado. Privilégios de administrador necessários.',
        code: 'ADMIN_REQUIRED'
      });
    }
    
    next();
    
  } catch (error) {
    console.error('Erro na autenticação de admin:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
};

// Middleware opcional de autenticação (não falha se não houver token)
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      req.user = null;
      req.userId = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.type === 'refresh') {
      req.user = null;
      req.userId = null;
      return next();
    }
    
    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      req.user = null;
      req.userId = null;
      return next();
    }
    
    req.user = user;
    req.userId = user._id;
    
    next();
    
  } catch (error) {
    // Em caso de erro, continuar sem autenticação
    req.user = null;
    req.userId = null;
    next();
  }
};

// Middleware para verificar propriedade de recurso
const checkResourceOwnership = (resourceModel, resourceIdParam = 'id') => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[resourceIdParam];
      const Model = require(`../models/${resourceModel}`);
      
      const resource = await Model.findById(resourceId);
      if (!resource) {
        return res.status(404).json({
          success: false,
          message: 'Recurso não encontrado',
          code: 'RESOURCE_NOT_FOUND'
        });
      }
      
      // Verificar se o usuário é o dono do recurso ou é admin
      if (resource.user.toString() !== req.userId.toString() && req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Acesso negado. Você não tem permissão para acessar este recurso.',
          code: 'ACCESS_DENIED'
        });
      }
      
      req.resource = resource;
      next();
      
    } catch (error) {
      console.error('Erro ao verificar propriedade do recurso:', error);
      res.status(500).json({
        success: false,
        message: 'Erro interno do servidor',
        code: 'INTERNAL_ERROR'
      });
    }
  };
};

// Middleware para rate limiting por usuário
const userRateLimit = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
  const requests = new Map();
  
  return (req, res, next) => {
    if (!req.userId) {
      return next();
    }
    
    const userId = req.userId.toString();
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // Limpar requests antigos
    if (requests.has(userId)) {
      const userRequests = requests.get(userId).filter(time => time > windowStart);
      requests.set(userId, userRequests);
    } else {
      requests.set(userId, []);
    }
    
    const userRequests = requests.get(userId);
    
    if (userRequests.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        message: 'Muitas requisições. Tente novamente mais tarde.',
        code: 'USER_RATE_LIMIT',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
    
    userRequests.push(now);
    next();
  };
};

// Middleware para log de atividades do usuário
const logUserActivity = (action) => {
  return (req, res, next) => {
    if (req.userId) {
      // TODO: Implementar sistema de logs de atividade
      console.log(`User ${req.userId} performed action: ${action}`);
    }
    next();
  };
};

module.exports = {
  auth,
  adminAuth,
  optionalAuth,
  checkResourceOwnership,
  userRateLimit,
  logUserActivity
};