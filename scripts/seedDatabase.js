const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('dotenv').config();

const User = require('../models/User');
const Investment = require('../models/Investment');
const Transaction = require('../models/Transaction');

// Conectar ao MongoDB
const connectDB = async () => {
  try {
    let mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/furby_investimentos';
    
    try {
      await mongoose.connect(mongoURI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000, // Timeout de 5 segundos
      });
      
      console.log('✅ Conectado ao MongoDB');
    } catch (localError) {
      console.log('⚠️ MongoDB local não disponível, iniciando MongoDB Memory Server...');
      
      // Usar MongoDB Memory Server como fallback
      const mongod = await MongoMemoryServer.create();
      mongoURI = mongod.getUri();
      
      await mongoose.connect(mongoURI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      
      console.log('✅ Conectado ao MongoDB Memory Server');
      console.log('📝 Nota: Usando banco de dados em memória para desenvolvimento');
    }
  } catch (error) {
    console.error('❌ Erro ao conectar com MongoDB:', error);
    process.exit(1);
  }
};

// Dados de exemplo
const seedData = async () => {
  try {
    console.log('🌱 Iniciando seed do banco de dados...');

    // Limpar dados existentes (apenas em desenvolvimento)
    if (process.env.NODE_ENV !== 'production') {
      await User.deleteMany({});
      await Investment.deleteMany({});
      await Transaction.deleteMany({});
      console.log('🗑️ Dados existentes removidos');
    }

    // Criar usuário administrador
    const adminPassword = await bcrypt.hash('admin123', 12);
    const admin = new User({
      name: 'Administrador',
      email: 'admin@furby.com',
      password: adminPassword,
      role: 'admin',
      balance: 0,
      isActive: true,
      emailVerified: true
    });
    await admin.save();
    console.log('👑 Usuário administrador criado');

    // Criar usuários de exemplo
    const users = [];
    
    const user1Password = await bcrypt.hash('123456', 12);
    const user1 = new User({
      name: 'João Silva',
      email: 'joao@email.com',
      password: user1Password,
      balance: 2500.00,
      totalInvested: 5000.00,
      totalEarnings: 750.00,
      investmentCount: 3,
      pixKey: '11999887766',
      pixKeyType: 'phone',
      isActive: true,
      emailVerified: true
    });
    await user1.save();
    users.push(user1);

    const user2Password = await bcrypt.hash('senha123', 12);
    const user2 = new User({
      name: 'Maria Santos',
      email: 'maria@email.com',
      password: user2Password,
      balance: 1800.50,
      totalInvested: 3000.00,
      totalEarnings: 450.00,
      investmentCount: 2,
      referredBy: user1._id,
      pixKey: 'maria@email.com',
      pixKeyType: 'email',
      isActive: true,
      emailVerified: true
    });
    await user2.save();
    users.push(user2);

    const user3Password = await bcrypt.hash('teste123', 12);
    const user3 = new User({
      name: 'Carlos Oliveira',
      email: 'carlos@email.com',
      password: user3Password,
      balance: 500.00,
      totalInvested: 1000.00,
      totalEarnings: 150.00,
      investmentCount: 1,
      referredBy: user2._id,
      pixKey: '12345678901',
      pixKeyType: 'cpf',
      isActive: true,
      emailVerified: true
    });
    await user3.save();
    users.push(user3);

    console.log('👥 Usuários de exemplo criados');

    // Criar investimentos de exemplo
    const investments = [];

    // Investimento ativo do João
    const investment1 = new Investment({
      user: user1._id,
      trader: {
        name: 'Carlos Silva',
        avatar: '/img/traders/carlos.jpg',
        successRate: 85.5,
        period: '30 dias',
        periodInDays: 30,
        minInvestment: 100,
        maxInvestment: 10000
      },
      amount: 2000,
      expectedReturn: 1710, // 85.5% de 2000
      actualReturn: 800, // Parcial
      status: 'active',
      startDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 dias atrás
      endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // 15 dias no futuro
      progress: 50,
      dailyReturns: [
        {
          date: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
          amount: 50,
          percentage: 2.5
        },
        {
          date: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000),
          amount: 75,
          percentage: 3.75
        },
        {
          date: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
          amount: 60,
          percentage: 3.0
        }
      ]
    });
    await investment1.save();
    investments.push(investment1);

    // Investimento completado da Maria
    const investment2 = new Investment({
      user: user2._id,
      trader: {
        name: 'Ana Costa',
        avatar: '/img/traders/ana.jpg',
        successRate: 92.3,
        period: '45 dias',
        periodInDays: 45,
        minInvestment: 500,
        maxInvestment: 25000
      },
      amount: 1500,
      expectedReturn: 1384.5, // 92.3% de 1500
      actualReturn: 1400,
      status: 'completed',
      startDate: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      completedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      progress: 100
    });
    await investment2.save();
    investments.push(investment2);

    // Investimento ativo do Carlos
    const investment3 = new Investment({
      user: user3._id,
      trader: {
        name: 'Roberto Santos',
        avatar: '/img/traders/roberto.jpg',
        successRate: 78.9,
        period: '60 dias',
        periodInDays: 60,
        minInvestment: 200,
        maxInvestment: 15000
      },
      amount: 800,
      expectedReturn: 631.2, // 78.9% de 800
      actualReturn: 200,
      status: 'active',
      startDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
      progress: 33
    });
    await investment3.save();
    investments.push(investment3);

    console.log('💰 Investimentos de exemplo criados');

    // Criar transações de exemplo
    const transactions = [];

    // Depósito do João
    const transaction1 = new Transaction({
      user: user1._id,
      type: 'deposit',
      method: 'pix',
      amount: 3000,
      netAmount: 3000,
      description: 'Depósito via PIX',
      status: 'completed',
      completedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      pix: {
        key: '11999887766',
        keyType: 'phone',
        txId: 'FURBY' + Date.now().toString(36).toUpperCase(),
        endToEndId: 'E' + Date.now() + 'EXAMPLE'
      }
    });
    await transaction1.save();
    transactions.push(transaction1);

    // Investimento do João
    const transaction2 = new Transaction({
      user: user1._id,
      type: 'investment',
      method: 'system',
      amount: 2000,
      netAmount: 2000,
      description: 'Investimento com Carlos Silva',
      investment: investment1._id,
      status: 'completed',
      completedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    });
    await transaction2.save();
    transactions.push(transaction2);

    // Retorno parcial do investimento do João
    const transaction3 = new Transaction({
      user: user1._id,
      type: 'return',
      method: 'system',
      amount: 800,
      netAmount: 800,
      description: 'Retorno parcial do investimento com Carlos Silva',
      investment: investment1._id,
      status: 'completed',
      completedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    });
    await transaction3.save();
    transactions.push(transaction3);

    // Depósito da Maria
    const transaction4 = new Transaction({
      user: user2._id,
      type: 'deposit',
      method: 'pix',
      amount: 2000,
      netAmount: 2000,
      description: 'Depósito via PIX',
      status: 'completed',
      completedAt: new Date(Date.now() - 55 * 24 * 60 * 60 * 1000),
      pix: {
        key: 'maria@email.com',
        keyType: 'email',
        txId: 'FURBY' + (Date.now() - 1000).toString(36).toUpperCase(),
        endToEndId: 'E' + (Date.now() - 1000) + 'EXAMPLE'
      }
    });
    await transaction4.save();
    transactions.push(transaction4);

    // Investimento da Maria
    const transaction5 = new Transaction({
      user: user2._id,
      type: 'investment',
      method: 'system',
      amount: 1500,
      netAmount: 1500,
      description: 'Investimento com Ana Costa',
      investment: investment2._id,
      status: 'completed',
      completedAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000)
    });
    await transaction5.save();
    transactions.push(transaction5);

    // Retorno completo do investimento da Maria
    const transaction6 = new Transaction({
      user: user2._id,
      type: 'return',
      method: 'system',
      amount: 1400,
      netAmount: 1400,
      description: 'Retorno do investimento com Ana Costa',
      investment: investment2._id,
      status: 'completed',
      completedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    });
    await transaction6.save();
    transactions.push(transaction6);

    // Comissão de indicação para João (pela Maria)
    const transaction7 = new Transaction({
      user: user1._id,
      type: 'referral',
      method: 'system',
      amount: 112, // 8% de 1400
      netAmount: 112,
      description: 'Comissão de indicação - Maria Santos',
      referredUser: user2._id,
      status: 'completed',
      completedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    });
    await transaction7.save();
    transactions.push(transaction7);

    console.log('💳 Transações de exemplo criadas');

    // Atualizar ganhos de indicação
    user1.referralEarnings = 112;
    await user1.save();

    console.log('✅ Seed do banco de dados concluído com sucesso!');
    console.log('📊 Dados criados:');
    console.log(`   - ${users.length + 1} usuários (incluindo admin)`);
    console.log(`   - ${investments.length} investimentos`);
    console.log(`   - ${transactions.length} transações`);
    console.log('');
    console.log('🔑 Credenciais de acesso:');
    console.log('   Admin: admin@furby.com / admin123');
    console.log('   João: joao@email.com / 123456');
    console.log('   Maria: maria@email.com / senha123');
    console.log('   Carlos: carlos@email.com / teste123');

  } catch (error) {
    console.error('❌ Erro durante o seed:', error);
  }
};

// Executar seed
const runSeed = async () => {
  await connectDB();
  await seedData();
  process.exit(0);
};

// Executar se chamado diretamente
if (require.main === module) {
  runSeed();
}

module.exports = { seedData, connectDB };