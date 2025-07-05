const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const transactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Usuário é obrigatório']
  },
  transactionId: {
    type: String,
    unique: true,
    default: () => uuidv4()
  },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'investment', 'return', 'referral', 'bonus'],
    required: [true, 'Tipo de transação é obrigatório']
  },
  method: {
    type: String,
    enum: ['pix', 'bank_transfer', 'credit_card', 'system'],
    required: [true, 'Método de pagamento é obrigatório']
  },
  amount: {
    type: Number,
    required: [true, 'Valor é obrigatório'],
    min: [0.01, 'Valor deve ser maior que R$ 0,01']
  },
  fee: {
    type: Number,
    default: 0,
    min: [0, 'Taxa não pode ser negativa']
  },
  netAmount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  description: {
    type: String,
    required: [true, 'Descrição é obrigatória'],
    trim: true,
    maxlength: [200, 'Descrição não pode ter mais de 200 caracteres']
  },
  // Dados específicos do PIX
  pix: {
    key: {
      type: String,
      default: null
    },
    keyType: {
      type: String,
      enum: ['cpf', 'email', 'phone', 'random'],
      default: null
    },
    qrCode: {
      type: String,
      default: null
    },
    qrCodeImage: {
      type: String,
      default: null
    },
    txId: {
      type: String,
      default: null
    },
    endToEndId: {
      type: String,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null
    }
  },
  // Dados bancários para transferência
  bankData: {
    bank: {
      type: String,
      default: null
    },
    agency: {
      type: String,
      default: null
    },
    account: {
      type: String,
      default: null
    },
    accountType: {
      type: String,
      enum: ['checking', 'savings'],
      default: null
    },
    holderName: {
      type: String,
      default: null
    },
    holderDocument: {
      type: String,
      default: null
    }
  },
  // Referência a investimento (se aplicável)
  investment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Investment',
    default: null
  },
  // Referência a usuário indicado (para comissões)
  referredUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Dados de processamento
  processedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  failureReason: {
    type: String,
    default: null
  },
  // Dados externos (webhook, API)
  externalId: {
    type: String,
    default: null
  },
  externalData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // Metadados
  metadata: {
    userAgent: String,
    ipAddress: String,
    platform: String
  },
  notes: {
    type: String,
    default: null,
    maxlength: [500, 'Notas não podem ter mais de 500 caracteres']
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      delete ret.__v;
      delete ret.externalData;
      return ret;
    }
  }
});

// Índices para performance
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ transactionId: 1 });
transactionSchema.index({ status: 1, type: 1 });
transactionSchema.index({ 'pix.txId': 1 });
transactionSchema.index({ externalId: 1 });
transactionSchema.index({ createdAt: -1 });

// Middleware para calcular valor líquido
transactionSchema.pre('save', function(next) {
  if (this.isModified('amount') || this.isModified('fee')) {
    this.netAmount = this.amount - this.fee;
  }
  next();
});

// Middleware para definir expiração do PIX
transactionSchema.pre('save', function(next) {
  if (this.isNew && this.method === 'pix' && this.type === 'deposit' && !this.pix.expiresAt) {
    // PIX expira em 30 minutos
    this.pix.expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  }
  next();
});

// Método para processar transação
transactionSchema.methods.process = async function() {
  this.status = 'processing';
  this.processedAt = new Date();
  
  const User = mongoose.model('User');
  const user = await User.findById(this.user);
  
  if (!user) {
    throw new Error('Usuário não encontrado');
  }
  
  try {
    switch (this.type) {
      case 'deposit':
        await user.addBalance(this.netAmount);
        break;
        
      case 'withdrawal':
        await user.subtractBalance(this.amount);
        break;
        
      case 'investment':
        await user.subtractBalance(this.amount);
        await user.addInvestment(this.amount);
        break;
        
      case 'return':
      case 'referral':
      case 'bonus':
        await user.addBalance(this.netAmount);
        break;
    }
    
    await this.complete();
  } catch (error) {
    await this.fail(error.message);
    throw error;
  }
  
  return this.save();
};

// Método para completar transação
transactionSchema.methods.complete = function() {
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

// Método para falhar transação
transactionSchema.methods.fail = function(reason) {
  this.status = 'failed';
  this.failureReason = reason;
  return this.save();
};

// Método para cancelar transação
transactionSchema.methods.cancel = function(reason = null) {
  this.status = 'cancelled';
  this.notes = reason || 'Transação cancelada';
  return this.save();
};

// Método para verificar se PIX expirou
transactionSchema.methods.isPixExpired = function() {
  if (this.method !== 'pix' || !this.pix.expiresAt) {
    return false;
  }
  return new Date() > this.pix.expiresAt;
};

// Método para gerar descrição automática
transactionSchema.methods.generateDescription = function() {
  const typeDescriptions = {
    deposit: 'Depósito via',
    withdrawal: 'Saque via',
    investment: 'Investimento em',
    return: 'Retorno de investimento',
    referral: 'Comissão de indicação',
    bonus: 'Bônus do sistema'
  };
  
  const methodDescriptions = {
    pix: 'PIX',
    bank_transfer: 'Transferência Bancária',
    credit_card: 'Cartão de Crédito',
    system: 'Sistema'
  };
  
  let description = typeDescriptions[this.type] || 'Transação';
  
  if (this.method && this.method !== 'system') {
    description += ` ${methodDescriptions[this.method] || this.method}`;
  }
  
  return description;
};

// Método estático para obter transações pendentes de PIX
transactionSchema.statics.getPendingPixTransactions = function() {
  return this.find({
    method: 'pix',
    status: { $in: ['pending', 'processing'] },
    'pix.expiresAt': { $gt: new Date() }
  }).populate('user');
};

// Método estático para obter transações expiradas
transactionSchema.statics.getExpiredTransactions = function() {
  return this.find({
    method: 'pix',
    status: { $in: ['pending', 'processing'] },
    'pix.expiresAt': { $lte: new Date() }
  });
};

// Método estático para estatísticas de transações
transactionSchema.statics.getTransactionStats = async function(userId = null, period = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - period);
  
  const matchStage = {
    createdAt: { $gte: startDate },
    status: 'completed'
  };
  
  if (userId) {
    matchStage.user = mongoose.Types.ObjectId(userId);
  }
  
  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: {
          type: '$type',
          method: '$method'
        },
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        totalFees: { $sum: '$fee' },
        avgAmount: { $avg: '$amount' }
      }
    },
    {
      $group: {
        _id: '$_id.type',
        methods: {
          $push: {
            method: '$_id.method',
            count: '$count',
            totalAmount: '$totalAmount',
            totalFees: '$totalFees',
            avgAmount: '$avgAmount'
          }
        },
        totalCount: { $sum: '$count' },
        totalAmount: { $sum: '$totalAmount' },
        totalFees: { $sum: '$totalFees' }
      }
    }
  ]);
  
  return stats;
};

// Método estático para encontrar por ID externo
transactionSchema.statics.findByExternalId = function(externalId) {
  return this.findOne({ externalId: externalId });
};

// Método estático para encontrar por txId do PIX
transactionSchema.statics.findByPixTxId = function(txId) {
  return this.findOne({ 'pix.txId': txId });
};

module.exports = mongoose.model('Transaction', transactionSchema);