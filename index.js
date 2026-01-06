const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json());
// 获取所有聊天列表
app.get('/chats', async (req, res) => {
  try {
    if (!client || !client.info) {
      return res.status(503).json({ error: 'WhatsApp 未连接' });
    }
    
    // 使用 whatsapp-web.js 的 getChats() 方法获取所有聊天
    const chats = await client.getChats();
    
    // 格式化返回数据
    const formattedChats = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.pushname || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount || 0,
      lastMessage: chat.lastMessage ? {
        body: chat.lastMessage.body,
        timestamp: chat.lastMessage.timestamp,
        fromMe: chat.lastMessage.fromMe
      } : null
    }));
    
    res.json(formattedChats);
  } catch (error) {
    console.error('获取聊天列表失败:', error);
    res.status(500).json({ error: '获取聊天列表失败' });
  }
});

// 状态变量
let qrCodeData = null;
let clientStatus = 'disconnected'; // disconnected, connecting, connected
let webhookUrl = null;
let autoReplyEnabled = false;

// WhatsApp 客户端配置
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './session'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

// QR 码生成事件
client.on('qr', async (qr) => {
  console.log('📱 QR 码已生成，请扫描登录');
  clientStatus = 'connecting';
  try {
    qrCodeData = await qrcode.toDataURL(qr);
  } catch (err) {
    console.error('QR 码生成失败:', err);
  }
});

// 登录成功
client.on('ready', () => {
  console.log('✅ WhatsApp Web 客户端已就绪');
  clientStatus = 'connected';
  qrCodeData = null; // 登录成功后清除 QR 码
});

// 认证成功（已有 session）
client.on('authenticated', () => {
  console.log('🔐 认证成功');
  clientStatus = 'connecting';
});

// 认证失败
client.on('auth_failure', (msg) => {
  console.error('❌ 认证失败:', msg);
  clientStatus = 'disconnected';
});

// 断开连接
client.on('disconnected', (reason) => {
  console.log('🔌 连接断开:', reason);
  clientStatus = 'disconnected';
  qrCodeData = null;
  
  // 尝试重新初始化
  setTimeout(() => {
    console.log('🔄 尝试重新连接...');
    client.initialize();
  }, 5000);
});

// 收到消息
client.on('message', async (msg) => {
  console.log(`📨 收到消息 - 来自: ${msg.from}, 内容: ${msg.body}`);
  
  // 忽略群组消息和自己发的消息
  if (msg.from.includes('@g.us') || msg.fromMe) {
    return;
  }
  
  // 如果启用了自动回复且配置了 webhook
  if (autoReplyEnabled && webhookUrl) {
    try {
      console.log(`🤖 调用 webhook: ${webhookUrl}`);
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: msg.from.replace('@c.us', ''),
          body: msg.body,
          timestamp: msg.timestamp,
          type: msg.type
        })
      });
      
      const data = await response.json();
      console.log('📤 Webhook 响应:', data);
      
      // 如果返回了回复内容，发送回复
      if (data.reply) {
        await msg.reply(data.reply);
        console.log(`✅ 已发送回复: ${data.reply.substring(0, 50)}...`);
        
        // 如果有媒体 URL，也发送媒体
        if (data.mediaUrl) {
          const { MessageMedia } = require('whatsapp-web.js');
          const media = await MessageMedia.fromUrl(data.mediaUrl);
          await client.sendMessage(msg.from, media);
          console.log('✅ 已发送媒体附件');
        }
      }
    } catch (error) {
      console.error('❌ Webhook 调用失败:', error.message);
    }
  }
});

// ============ API 端点 ============

// 健康检查
app.get('/', (req, res) => {
  res.json({
    service: 'WhatsApp Web Service',
    status: 'running',
    clientStatus: clientStatus,
    autoReply: autoReplyEnabled,
    webhookConfigured: !!webhookUrl
  });
});

// 获取 QR 码
app.get('/qr', (req, res) => {
  res.json({
    qr: qrCodeData,
    status: clientStatus
  });
});

// 获取状态
app.get('/status', (req, res) => {
  res.json({
    status: clientStatus,
    autoReply: autoReplyEnabled,
    webhookUrl: webhookUrl ? '已配置' : '未配置'
  });
});

// 刷新 QR 码（重新初始化）
app.post('/refresh-qr', async (req, res) => {
  try {
    console.log('🔄 正在刷新 QR 码...');
    clientStatus = 'connecting';
    qrCodeData = null;
    
    await client.destroy();
    await client.initialize();
    
    res.json({ success: true, message: 'QR 码正在刷新，请稍候' });
  } catch (error) {
    console.error('刷新失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 配置 Webhook
app.post('/webhook', (req, res) => {
  const { url, enabled } = req.body;
  
  if (url !== undefined) {
    webhookUrl = url;
    console.log(`🔗 Webhook URL 已设置: ${url}`);
  }
  
  if (enabled !== undefined) {
    autoReplyEnabled = enabled;
    console.log(`🤖 自动回复已${enabled ? '启用' : '禁用'}`);
  }
  
  res.json({
    success: true,
    webhookUrl: webhookUrl,
    autoReplyEnabled: autoReplyEnabled
  });
});

// 发送消息
app.post('/send', async (req, res) => {
  try {
    const { to, message, mediaUrl } = req.body;
    
    console.log('Sending message to:', to);
    
    // 使用 getContactById 和 getChat 解决 LID 问题
    const contact = await client.getContactById(to);
    const chat = await contact.getChat();
    
    let result;
    if (mediaUrl) {
      const { MessageMedia } = require('whatsapp-web.js');
      const media = await MessageMedia.fromUrl(mediaUrl);
      result = await chat.sendMessage(media, { caption: message });
    } else {
      result = await chat.sendMessage(message);
    }
    
    console.log('Message sent successfully:', result.id._serialized);
    res.json({ success: true, messageId: result.id._serialized });
  } catch (error) {
    console.error('Send error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

    // 格式化电话号码
    let formattedNumber = to.replace(/\D/g, '');
    if (!formattedNumber.includes('@c.us')) {
      formattedNumber = `${formattedNumber}@c.us`;
    }
    
    // 发送文本消息
    await client.sendMessage(formattedNumber, message);
    console.log(`✅ 消息已发送到 ${to}`);
    
    // 如果有媒体，也发送
    if (mediaUrl) {
      const { MessageMedia } = require('whatsapp-web.js');
      const media = await MessageMedia.fromUrl(mediaUrl);
      await client.sendMessage(formattedNumber, media);
      console.log('✅ 媒体已发送');
    }
    
    res.json({ success: true, message: '消息发送成功' });

    
  } catch (error) {
    console.error('发送失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 登出
app.post('/logout', async (req, res) => {
  try {
    await client.logout();
    clientStatus = 'disconnected';
    qrCodeData = null;
    res.json({ success: true, message: '已登出' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 启动服务 ============

const PORT = process.env.PORT || 3000;
// ========== 添加到你的 Express 服务中 ==========

// 获取所有聊天列表
app.get('/chats', async (req, res) => {
  try {
    if (!client || !client.info) {
      return res.status(503).json({ error: 'WhatsApp 未连接' });
    }
    
    const chats = await client.getChats();
    
    const formattedChats = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.pushname || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount || 0,
      lastMessage: chat.lastMessage ? {
        body: chat.lastMessage.body,
        timestamp: chat.lastMessage.timestamp,
        fromMe: chat.lastMessage.fromMe
      } : null
    }));
    
    res.json(formattedChats);
  } catch (error) {
    console.error('获取聊天列表失败:', error);
    res.status(500).json({ error: '获取聊天列表失败' });
  }
});

// 获取指定聊天的历史消息 (可选)
app.get('/chats/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    
    const formattedMessages = messages.map(msg => ({
      id: msg.id._serialized,
      body: msg.body,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      from: msg.from,
      to: msg.to,
      hasMedia: msg.hasMedia
    }));
    
    res.json(formattedMessages);
  } catch (error) {
    console.error('获取消息失败:', error);
    res.status(500).json({ error: '获取消息失败' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Web 服务已启动，端口: ${PORT}`);
  console.log('📡 正在初始化 WhatsApp 客户端...');
  client.initialize();
});

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('正在关闭服务...');
  await client.destroy();
  process.exit(0);
});
