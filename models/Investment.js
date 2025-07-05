const mongoose = require('mongoose');

const investmentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Usuário é obrigatório']
  },
  trader: {
    name: {
      type: String,
      required: [true, 'Nome do trader é obrigatório'],
      trim: true
    },
    avatar: {
      type: String,
      default: null
    },
    successRate: {
      type: Number,
      required: [true, 'Taxa de sucesso é obrigatória'],
      min: [0, 'Taxa de sucesso não pode ser negativa'],
      max: [1000, 'Taxa de sucesso não pode ser maior que 1000%']
    },
    period: {
      type: String,
      required: [true, 'Período é obrigatório']
    },
    periodInDays: {
      type: Number,
      required: [true, 'Período em dias é obrigatório'],
      min: [1, 'Período deve ser pelo menos 1 dia']
    },
    minInvestment: {
      type: Number,
      required: [true, 'Investimento mínimo é obrigatório'],
      min: [1, 'Investimento mínimo deve ser pelo menos R$ 1']
    },
    maxInvestment: {
      type: Number,
      required: [true, 'Investimento máximo é obrigatório'],
      min: [1, 'Investimento máximo deve ser pelo menos R$ 1']
    }
  },
  amount: {
    type: Number,
    required: [true, 'Valor do investimento é obrigatório'],
    min: [1, 'Valor do investimento deve ser pelo menos R$ 1']
  },
  expectedReturn: {
    type: Number,
    required: [true, 'Retorno esperado é obrigatório'],
    min: [0, 'Retorno esperado não pode ser negativo']
  },
  actualReturn: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'completed', 'cancelled'],
    default: 'pending'
  },
  startDate: {
    type: Date,
    default: null
  },
  endDate: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  progress: {
    type: Number,
    default: 0,
    min: [0, 'Progresso não pode ser negativo'],
    max: [100, 'Progresso não pode ser maior que 100%']
  },
  dailyReturns: [{
    date: {
      type: Date,
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    percentage: {
      type: Number,
      required: true
    }
  }],
  notes: {
    type: String,
    default: null,
    maxlength: [500, 'Notas não podem ter mais de 500 caracteres']
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      delete ret.__v;
      return ret;
    }
  }
});

// Índices para performance
investmentSchema.index({ user: 1, status: 1 });
investmentSchema.index({ status: 1, endDate: 1 });
investmentSchema.index({ createdAt: -1 });
investmentSchema.index({ 'trader.name': 1 });

// Middleware para calcular data de fim quando o investimento é ativado
investmentSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === 'active' && !this.startDate) {
    this.startDate = new Date();
    this.endDate = new Date(Date.now() + (this.trader.periodInDays * 24 * 60 * 60 * 1000));
  }
  next();
});

// Middleware para calcular retorno esperado
investmentSchema.pre('save', function(next) {
  if (this.isModified('amount') || this.isModified('trader.successRate')) {
    this.expectedReturn = this.amount * (this.trader.successRate / 100);
  }
  next();
});

// Método para calcular progresso
investmentSchema.methods.calculateProgress = function() {
  if (this.status !== 'active' || !this.startDate || !this.endDate) {
    return 0;
  }
  
  const now = new Date();
  const totalDuration = this.endDate.getTime() - this.startDate.getTime();
  const elapsed = now.getTime() - this.startDate.getTime();
  
  const progress = Math.min((elapsed / totalDuration) * 100, 100);
  this.progress = Math.max(progress, 0);
  
  return this.progress;
};

// Método para adicionar retorno diário
investmentSchema.methods.addDailyReturn = function(amount, percentage) {
  this.dailyReturns.push({
    date: new Date(),
    amount: amount,
    percentage: percentage
  });
  
  this.actualReturn += amount;
  return this.save();
};

// Método para completar investimento
investmentSchema.methods.complete = async function() {
  this.status = 'completed';
  this.completedAt = new Date();
  this.progress = 100;
  
  // Adicionar ganhos ao usuário
  const User = mongoose.model('User');
  const user = await User.findById(this.user);
  
  if (user) {
    await user.addEarnings(this.actualReturn);
    
    // Processar comissões de indicação
    if (user.referredBy) {
      await this.processReferralCommissions(user.referredBy, this.actualReturn);
    }
  }
  
  return this.save();
};

// Método para processar comissões de indicação
investmentSchema.methods.processReferralCommissions = async function(referrerId, earnings) {
  const User = mongoose.model('User');
  
  // Nível 1: 8%
  const level1User = await User.findById(referrerId);
  if (level1User) {
    const commission1 = earnings * 0.08;
    await level1User.addReferralEarnings(commission1);
    
    // Nível 2: 3%
    if (level1User.referredBy) {
      const level2User = await User.findById(level1User.referredBy);
      if (level2User) {
        const commission2 = earnings * 0.03;
        await level2User.addReferralEarnings(commission2);
        
        // Nível 3: 1%
        if (level2User.referredBy) {
          const level3User = await User.findById(level2User.referredBy);
          if (level3User) {
            const commission3 = earnings * 0.01;
            await level3User.addReferralEarnings(commission3);
          }
        }
      }
    }
  }
};

// Método para cancelar investimento
investmentSchema.methods.cancel = async function(reason = null) {
  this.status = 'cancelled';
  this.notes = reason || 'Investimento cancelado';
  
  // Devolver valor ao usuário se ainda não foi processado
  if (this.status === 'pending') {
    const User = mongoose.model('User');
    const user = await User.findById(this.user);
    if (user) {
      await user.addBalance(this.amount);
    }
  }
  
  return this.save();
};

// Método estático para obter investimentos ativos que devem ser finalizados
investmentSchema.statics.getExpiredInvestments = function() {
  return this.find({
    status: 'active',
    endDate: { $lte: new Date() }
  }).populate('user');
};

// Método estático para estatísticas de investimentos
investmentSchema.statics.getInvestmentStats = async function(userId = null) {
  const matchStage = userId ? { user: mongoose.Types.ObjectId(userId) } : {};
  
  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        totalReturn: { $sum: '$actualReturn' }
      }
    }
  ]);
  
  const result = {
    total: 0,
    active: 0,
    completed: 0,
    cancelled: 0,
    totalInvested: 0,
    totalReturns: 0
  };
  
  stats.forEach(stat => {
    result.total += stat.count;
    result[stat._id] = stat.count;
    result.totalInvested += stat.totalAmount;
    result.totalReturns += stat.totalReturn;
  });
  
  return result;
};

module.exports = mongoose.model('Investment', investmentSchema);