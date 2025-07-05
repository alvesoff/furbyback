const mongoose = require('mongoose');
const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Investment = require('../models/Investment');

// Configurações ASAAS
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_BASE_URL || 'https://sandbox.asaas.com/api/v3';

// Headers para ASAAS
const getAsaasHeaders = () => ({
  'Content-Type': 'application/json',
  'access_token': ASAAS_API_KEY
});

// Conectar ao MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/furby_investimentos', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ PIX Automation - Conectado ao MongoDB');
  } catch (error) {
    console.error('❌ Erro ao conectar com MongoDB:', error);
    process.exit(1);
  }
};

// Simular consulta de pagamentos PIX (em produção, usar API real do banco)
const checkPixPayments = async () => {
  try {
    console.log('🔍 Verificando pagamentos PIX pendentes...');
    
    const pendingTransactions = await Transaction.find({
      type: 'deposit',
      method: 'pix',
      status: 'pending',
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Últimas 24h
    }).populate('user');

    console.log(`📋 Encontradas ${pendingTransactions.length} transações PIX pendentes`);

    for (const transaction of pendingTransactions) {
      // Simular verificação de pagamento (em produção, consultar API do banco)
      const paymentReceived = await simulatePixPaymentCheck(transaction);
      
      if (paymentReceived) {
        await processPixPayment(transaction);
      }
    }

    // Verificar transações expiradas
    await expireOldPixTransactions();

  } catch (error) {
    console.error('❌ Erro ao verificar pagamentos PIX:', error);
  }
};

// Verificar status de pagamento no ASAAS
const checkAsaasPaymentStatus = async (paymentId) => {
  try {
    if (!ASAAS_API_KEY) {
      console.log('⚠️ ASAAS_API_KEY não configurada, pulando verificação');
      return false;
    }

    const response = await axios.get(
      `${ASAAS_BASE_URL}/payments/${paymentId}`,
      { headers: getAsaasHeaders() }
    );

    const payment = response.data;
    return payment.status === 'RECEIVED';
    
  } catch (error) {
    console.error(`❌ Erro ao verificar pagamento ASAAS ${paymentId}:`, error.response?.data || error.message);
    return false;
  }
};

// Simular verificação de pagamento PIX
const simulatePixPaymentCheck = async (transaction) => {
  // Verificar se é transação ASAAS
  if (transaction.metadata?.provider === 'asaas' && transaction.pix?.asaasPaymentId) {
    return await checkAsaasPaymentStatus(transaction.pix.asaasPaymentId);
  }
  
  // Em produção, aqui seria feita uma consulta real à API do banco
  // Por enquanto, simular que 30% dos pagamentos são confirmados
  const random = Math.random();
  
  // Simular que transações mais antigas têm maior chance de serem pagas
  const ageInMinutes = (Date.now() - transaction.createdAt.getTime()) / (1000 * 60);
  const paymentProbability = Math.min(0.3 + (ageInMinutes / 60) * 0.1, 0.8);
  
  return random < paymentProbability;
};

// Processar pagamento PIX confirmado
const processPixPayment = async (transaction) => {
  try {
    console.log(`💰 Processando pagamento PIX: ${transaction.transactionId}`);
    
    // Atualizar status da transação
    transaction.status = 'completed';
    transaction.completedAt = new Date();
    transaction.pix.endToEndId = `E${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    await transaction.save();
    
    // Adicionar saldo ao usuário
    const user = await User.findById(transaction.user);
    if (user) {
      await user.addBalance(transaction.netAmount);
      console.log(`✅ Saldo adicionado: R$ ${transaction.netAmount.toFixed(2)} para ${user.name}`);
      
      // Processar comissão de indicação se aplicável
      if (user.referredBy) {
        await processReferralCommission(user, transaction.netAmount);
      }
    }
    
    // Log da transação processada
    console.log(`✅ Pagamento PIX processado: ${transaction.transactionId} - R$ ${transaction.amount.toFixed(2)}`);
    
  } catch (error) {
    console.error(`❌ Erro ao processar pagamento PIX ${transaction.transactionId}:`, error);
  }
};

// Processar comissão de indicação
const processReferralCommission = async (user, depositAmount) => {
  try {
    const referrer = await User.findById(user.referredBy);
    if (!referrer) return;
    
    // Calcular comissão (5% do depósito)
    const commissionRate = 0.05;
    const commissionAmount = depositAmount * commissionRate;
    
    // Criar transação de comissão
    const commissionTransaction = new Transaction({
      user: referrer._id,
      type: 'referral',
      method: 'system',
      amount: commissionAmount,
      netAmount: commissionAmount,
      description: `Comissão de indicação - ${user.name}`,
      referredUser: user._id,
      status: 'completed',
      completedAt: new Date()
    });
    
    await commissionTransaction.save();
    
    // Adicionar saldo e atualizar ganhos de indicação
    await referrer.addBalance(commissionAmount);
    referrer.referralEarnings += commissionAmount;
    await referrer.save();
    
    console.log(`💸 Comissão de indicação processada: R$ ${commissionAmount.toFixed(2)} para ${referrer.name}`);
    
  } catch (error) {
    console.error('❌ Erro ao processar comissão de indicação:', error);
  }
};

// Expirar transações PIX antigas
const expireOldPixTransactions = async () => {
  try {
    const expiredTransactions = await Transaction.find({
      type: 'deposit',
      method: 'pix',
      status: 'pending',
      createdAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) } // Mais de 30 minutos
    });
    
    for (const transaction of expiredTransactions) {
      transaction.status = 'expired';
      transaction.metadata = {
        ...transaction.metadata,
        expiredAt: new Date(),
        reason: 'Tempo limite excedido'
      };
      await transaction.save();
      
      console.log(`⏰ Transação PIX expirada: ${transaction.transactionId}`);
    }
    
    if (expiredTransactions.length > 0) {
      console.log(`⏰ ${expiredTransactions.length} transações PIX expiradas`);
    }
    
  } catch (error) {
    console.error('❌ Erro ao expirar transações PIX:', error);
  }
};

// Processar saques PIX pendentes
const processPixWithdrawals = async () => {
  try {
    console.log('💸 Processando saques PIX pendentes...');
    
    const pendingWithdrawals = await Transaction.find({
      type: 'withdrawal',
      method: 'pix',
      status: 'pending'
    }).populate('user');
    
    console.log(`📋 Encontrados ${pendingWithdrawals.length} saques PIX pendentes`);
    
    for (const withdrawal of pendingWithdrawals) {
      // Simular processamento do saque (em produção, usar API real do banco)
      const processed = await simulatePixWithdrawalProcessing(withdrawal);
      
      if (processed) {
        withdrawal.status = 'completed';
        withdrawal.completedAt = new Date();
        withdrawal.pix.endToEndId = `E${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
        await withdrawal.save();
        
        console.log(`✅ Saque PIX processado: ${withdrawal.transactionId} - R$ ${withdrawal.amount.toFixed(2)}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Erro ao processar saques PIX:', error);
  }
};

// Simular processamento de saque PIX
const simulatePixWithdrawalProcessing = async (withdrawal) => {
  // Em produção, aqui seria feita a transferência real via API do banco
  // Por enquanto, simular que 90% dos saques são processados com sucesso
  return Math.random() < 0.9;
};

// Atualizar progresso dos investimentos
const updateInvestmentProgress = async () => {
  try {
    console.log('📈 Atualizando progresso dos investimentos...');
    
    const activeInvestments = await Investment.find({ status: 'active' }).populate('user');
    
    for (const investment of activeInvestments) {
      const now = new Date();
      const startDate = investment.startDate;
      const endDate = investment.endDate;
      
      // Calcular progresso baseado no tempo
      const totalDuration = endDate.getTime() - startDate.getTime();
      const elapsed = now.getTime() - startDate.getTime();
      const timeProgress = Math.min(Math.max(elapsed / totalDuration * 100, 0), 100);
      
      // Atualizar progresso
      investment.progress = Math.round(timeProgress);
      
      // Simular retorno diário (apenas se não houve retorno hoje)
      const today = new Date().toDateString();
      const hasReturnToday = investment.dailyReturns.some(
        return_ => return_.date.toDateString() === today
      );
      
      if (!hasReturnToday && timeProgress > 0 && timeProgress < 100) {
        const dailyReturnPercentage = (Math.random() * 4) + 1; // 1-5% ao dia
        const dailyReturnAmount = investment.amount * (dailyReturnPercentage / 100);
        
        investment.dailyReturns.push({
          date: new Date(),
          amount: dailyReturnAmount,
          percentage: dailyReturnPercentage
        });
        
        investment.actualReturn += dailyReturnAmount;
        
        // Adicionar retorno ao saldo do usuário
        await investment.user.addBalance(dailyReturnAmount);
        
        // Criar transação de retorno
        const returnTransaction = new Transaction({
          user: investment.user._id,
          type: 'return',
          method: 'system',
          amount: dailyReturnAmount,
          netAmount: dailyReturnAmount,
          description: `Retorno diário - ${investment.trader.name}`,
          investment: investment._id,
          status: 'completed',
          completedAt: new Date()
        });
        
        await returnTransaction.save();
        
        console.log(`📈 Retorno diário adicionado: R$ ${dailyReturnAmount.toFixed(2)} para ${investment.user.name}`);
      }
      
      // Verificar se o investimento deve ser completado
      if (timeProgress >= 100 && investment.status === 'active') {
        investment.status = 'completed';
        investment.completedAt = new Date();
        
        // Processar comissões de indicação
        await processInvestmentReferralCommissions(investment);
        
        console.log(`✅ Investimento completado: ${investment._id}`);
      }
      
      await investment.save();
    }
    
    console.log(`📈 ${activeInvestments.length} investimentos atualizados`);
    
  } catch (error) {
    console.error('❌ Erro ao atualizar investimentos:', error);
  }
};

// Processar comissões de indicação para investimentos
const processInvestmentReferralCommissions = async (investment) => {
  try {
    const user = await User.findById(investment.user).populate('referredBy');
    if (!user || !user.referredBy) return;
    
    // Comissão de 8% sobre os ganhos do investimento
    const commissionRate = 0.08;
    const profit = investment.actualReturn - investment.amount;
    
    if (profit > 0) {
      const commissionAmount = profit * commissionRate;
      
      // Criar transação de comissão
      const commissionTransaction = new Transaction({
        user: user.referredBy._id,
        type: 'referral',
        method: 'system',
        amount: commissionAmount,
        netAmount: commissionAmount,
        description: `Comissão de investimento - ${user.name}`,
        referredUser: user._id,
        investment: investment._id,
        status: 'completed',
        completedAt: new Date()
      });
      
      await commissionTransaction.save();
      
      // Adicionar saldo e atualizar ganhos de indicação
      await user.referredBy.addBalance(commissionAmount);
      user.referredBy.referralEarnings += commissionAmount;
      await user.referredBy.save();
      
      console.log(`💸 Comissão de investimento processada: R$ ${commissionAmount.toFixed(2)} para ${user.referredBy.name}`);
    }
    
  } catch (error) {
    console.error('❌ Erro ao processar comissão de investimento:', error);
  }
};

// Configurar jobs automáticos
const setupAutomationJobs = () => {
  console.log('⚙️ Configurando jobs de automação...');
  
  // Verificar pagamentos PIX a cada 2 minutos
  cron.schedule('*/2 * * * *', () => {
    console.log('🔄 Executando verificação de pagamentos PIX...');
    checkPixPayments();
  });
  
  // Processar saques PIX a cada 5 minutos
  cron.schedule('*/5 * * * *', () => {
    console.log('🔄 Executando processamento de saques PIX...');
    processPixWithdrawals();
  });
  
  // Atualizar investimentos a cada hora
  cron.schedule('0 * * * *', () => {
    console.log('🔄 Executando atualização de investimentos...');
    updateInvestmentProgress();
  });
  
  // Limpeza de dados antigos todos os dias às 3h
  cron.schedule('0 3 * * *', () => {
    console.log('🔄 Executando limpeza de dados...');
    cleanupOldData();
  });
  
  console.log('✅ Jobs de automação configurados');
};

// Limpeza de dados antigos
const cleanupOldData = async () => {
  try {
    console.log('🧹 Iniciando limpeza de dados antigos...');
    
    // Remover transações expiradas com mais de 7 dias
    const oldExpiredTransactions = await Transaction.deleteMany({
      status: 'expired',
      createdAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    });
    
    console.log(`🗑️ ${oldExpiredTransactions.deletedCount} transações expiradas removidas`);
    
    // Remover logs antigos (se houver)
    // Aqui você pode adicionar limpeza de outros dados antigos
    
    console.log('✅ Limpeza de dados concluída');
    
  } catch (error) {
    console.error('❌ Erro na limpeza de dados:', error);
  }
};

// Inicializar automação
const initializeAutomation = async () => {
  try {
    await connectDB();
    setupAutomationJobs();
    
    console.log('🚀 PIX Automation iniciado com sucesso!');
    console.log('📋 Jobs configurados:');
    console.log('   - Verificação de pagamentos PIX: a cada 2 minutos');
    console.log('   - Processamento de saques PIX: a cada 5 minutos');
    console.log('   - Atualização de investimentos: a cada hora');
    console.log('   - Limpeza de dados: diariamente às 3h');
    
  } catch (error) {
    console.error('❌ Erro ao inicializar automação:', error);
    process.exit(1);
  }
};

// Executar se chamado diretamente
if (require.main === module) {
  initializeAutomation();
}

module.exports = {
  checkPixPayments,
  processPixWithdrawals,
  updateInvestmentProgress,
  setupAutomationJobs,
  initializeAutomation
};