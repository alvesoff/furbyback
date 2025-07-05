const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Nome é obrigatório'],
    trim: true,
    minlength: [3, 'Nome deve ter pelo menos 3 caracteres'],
    maxlength: [100, 'Nome deve ter no máximo 100 caracteres']
  },
  email: {
    type: String,
    required: [true, 'Email é obrigatório'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email inválido']
  },
  password: {
    type: String,
    required: [true, 'Senha é obrigatória'],
    minlength: [6, 'Senha deve ter pelo menos 6 caracteres'],
    select: false // Não retornar senha nas consultas por padrão
  },
  balance: {
    type: Number,
    default: 0,
    min: [0, 'Saldo não pode ser negativo']
  },
  pixKey: {
    type: String,
    default: null,
    trim: true
  },
  pixKeyType: {
    type: String,
    enum: ['cpf', 'email', 'phone', 'random'],
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  referralEarnings: {
    type: Number,
    default: 0
  },
  totalInvested: {
    type: Number,
    default: 0
  },
  totalEarnings: {
    type: Number,
    default: 0
  },
  investmentCount: {
    type: Number,
    default: 0
  },
  lastLogin: {
    type: Date,
    default: null
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationToken: {
    type: String,
    default: null
  },
  passwordResetToken: {
    type: String,
    default: null
  },
  passwordResetExpires: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      delete ret.password;
      delete ret.emailVerificationToken;
      delete ret.passwordResetToken;
      delete ret.__v;
      return ret;
    }
  }
});

// Índices para performance
userSchema.index({ email: 1 });
userSchema.index({ referralCode: 1 });
userSchema.index({ referredBy: 1 });
userSchema.index({ createdAt: -1 });

// Middleware para hash da senha antes de salvar
userSchema.pre('save', async function(next) {
  // Só fazer hash se a senha foi modificada
  if (!this.isModified('password')) return next();
  
  try {
    // Hash da senha com salt de 12
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (error) {
    next(error);
  }
});

// Middleware para gerar código de indicação
userSchema.pre('save', function(next) {
  if (this.isNew && !this.referralCode) {
    // Gerar código único baseado no ID e timestamp
    this.referralCode = 'FURBY' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
  }
  next();
});

// Método para comparar senhas
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Método para atualizar último login
userSchema.methods.updateLastLogin = function() {
  this.lastLogin = new Date();
  return this.save({ validateBeforeSave: false });
};

// Método para adicionar saldo
userSchema.methods.addBalance = function(amount) {
  this.balance += amount;
  return this.save();
};

// Método para subtrair saldo
userSchema.methods.subtractBalance = function(amount) {
  if (this.balance < amount) {
    throw new Error('Saldo insuficiente');
  }
  this.balance -= amount;
  return this.save();
};

// Método para adicionar investimento
userSchema.methods.addInvestment = function(amount) {
  this.totalInvested += amount;
  this.investmentCount += 1;
  return this.save();
};

// Método para adicionar ganhos
userSchema.methods.addEarnings = function(amount) {
  this.totalEarnings += amount;
  this.balance += amount;
  return this.save();
};

// Método para adicionar ganhos de indicação
userSchema.methods.addReferralEarnings = function(amount) {
  this.referralEarnings += amount;
  this.balance += amount;
  return this.save();
};

// Método estático para encontrar por código de indicação
userSchema.statics.findByReferralCode = function(code) {
  return this.findOne({ referralCode: code, isActive: true });
};

// Método estático para estatísticas do usuário
userSchema.statics.getUserStats = async function(userId) {
  const user = await this.findById(userId);
  if (!user) return null;
  
  const Investment = mongoose.model('Investment');
  const Transaction = mongoose.model('Transaction');
  
  const [activeInvestments, totalTransactions, referrals] = await Promise.all([
    Investment.countDocuments({ user: userId, status: 'active' }),
    Transaction.countDocuments({ user: userId }),
    this.countDocuments({ referredBy: userId })
  ]);
  
  return {
    user: user.toJSON(),
    stats: {
      activeInvestments,
      totalTransactions,
      referrals,
      totalInvested: user.totalInvested,
      totalEarnings: user.totalEarnings,
      referralEarnings: user.referralEarnings,
      balance: user.balance
    }
  };
};

module.exports = mongoose.model('User', userSchema);