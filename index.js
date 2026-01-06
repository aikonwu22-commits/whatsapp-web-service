'use strict';

const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// ============ 基础配置 ============

const app = express();
app.set('trust proxy', 1);

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // 处理预检
app.use(express.json({ limit: '2mb' }));

// ============ 状态变量 ============

let qrCodeData = null; // dataURL
let clientStatus = 'disconnected'; // disconnected | connecting | connected
let webhookUrl = null;
let autoReplyEnabled = false;

// ============ WhatsApp 客户端 ============

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './session',
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
      '--disable-gpu',
    ],
  },
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

// 已认证（已有 session）
client.on('authenticated', () => {
  console.log('🔐 认证成功');
  clientStatus = 'connecting';
});

// 登录成功
client.on('ready', () => {
  console.log('✅ WhatsApp Web 客户端已就绪');
  clientStatus = 'connected';
  qrCodeData = null;
});

// 认证失败
client.on('auth_failure', (msg) => {
  console.error('❌ 认证失败:', msg);
  clientStatus = 'disconnected';
  qrCodeData = null;
});

// 断开连接
client.on('disconnected', (reason) => {
  console.log('🔌 连接断开:', reason);
  clientStatus = 'disconnected';
  qrCodeData = null;

  // 尝试重新初始化
  setTimeout(() => {
    console.log('🔄 尝试重新连接...');
    client.initialize().catch((e) => console.error('重新连接失败:', e));
  }, 5000);
});

// Node < 18 时 fetch 不存在：需要你安装 node-fetch 或升级 Node 版本
// Railway 上建议直接用 Node 18/20
const ensureFetch = async () => {
  if (typeof fetch !== 'function') {
    // eslint-disable-next-line global-require
    const nodeFetch = (await import('node-fetch')).default;
    global.fetch = nodeFetch;
  }
};

client.on('message', async (msg) => {
  try {
    console.log(`📨 收到消息 - 来自: ${msg.from}, 内容: ${msg.body}`);

    // 忽略群组消息和自己发的消息
    if (msg.from.includes('@g.us') || msg.fromMe) return;

    if (autoReplyEnabled && webhookUrl) {
      await ensureFetch();

      console.log(`🤖 调用 webhook: ${webhookUrl}`);

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: msg.from.replace('@c.us', ''),
          body: msg.body,
          timestamp: msg.timestamp,
          type: msg.type,
        }),
      });

      const data = await response.json().catch(() => ({}));
      console.log('📤 Webhook 响应:', data);

      if (data && data.reply) {
        await msg.reply(data.reply);
        console.log(`✅ 已发送回复: ${String(data.reply).substring(0, 50)}...`);

        if (data.mediaUrl) {
          const media = await MessageMedia.fromUrl(data.mediaUrl);
          await client.sendMessage(msg.from, media);
          console.log('✅ 已发送媒体附件');
        }
      }
    }
  } catch (error) {
    console.error('❌ message handler 错误:', error);
  }
});

// ============ 工具函数 ============

function normalizeTo(to) {
  if (!to) return null;

  // 已经是 whatsapp id（@c.us / @g.us / @lid 等）
  if (to.includes('@')) return to;

  // 纯手机号：去掉非数字
  const digits = String(to).replace(/\D/g, '');
  if (!digits) return null;

  return `${digits}@c.us`;
}

// ============ API 端点 ============

// 健康检查
app.get('/', (req, res) => {
  res.json({
    service: 'WhatsApp Web Service',
    status: 'running',
    clientStatus,
    autoReply: autoReplyEnabled,
    webhookConfigured: !!webhookUrl,
  });
});

// 获取状态
app.get('/status', (req, res) => {
  res.json({
    status: clientStatus,
    autoReply: autoReplyEnabled,
    webhookUrl: webhookUrl ? '已配置' : '未配置',
  });
});

// 获取 QR 码
app.get('/qr', (req, res) => {
  res.json({
    qr: qrCodeData,
    status: clientStatus,
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
  const { url, enabled } = req.body || {};

  if (url !== undefined) {
    webhookUrl = url;
    console.log(`🔗 Webhook URL 已设置: ${url}`);
  }

  if (enabled !== undefined) {
    autoReplyEnabled = !!enabled;
    console.log(`🤖 自动回复已${autoReplyEnabled ? '启用' : '禁用'}`);
  }

  res.json({
    success: true,
    webhookUrl,
    autoReplyEnabled,
  });
});

// 获取所有聊天列表
app.get('/chats', async (req, res) => {
  try {
    if (!client || !client.info) {
      return res.status(503).json({ error: 'WhatsApp 未连接' });
    }

    const chats = await client.getChats();

    const formattedChats = chats.map((chat) => ({
      id: chat.id?._serialized,
      name: chat.name || chat.pushname || chat.id?.user,
      isGroup: !!chat.isGroup,
      unreadCount: chat.unreadCount || 0,
      lastMessage: chat.lastMessage
        ? {
            body: chat.lastMessage.body,
            timestamp: chat.lastMessage.timestamp,
            fromMe: chat.lastMessage.fromMe,
          }
        : null,
    }));

    res.json(formattedChats);
  } catch (error) {
    console.error('获取聊天列表失败:', error);
    res.status(500).json({ error: '获取聊天列表失败', detail: error.message });
  }
});

// 获取指定聊天历史消息（可选）
app.get('/chats/:chatId/messages', async (req, res) => {
  try {
    if (!client || !client.info) {
      return res.status(503).json({ error: 'WhatsApp 未连接' });
    }

    const { chatId } = req.params;
    const limit = Number.parseInt(req.query.limit, 10) || 50;

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });

    const formattedMessages = messages.map((m) => ({
      id: m.id?._serialized,
      body: m.body,
      timestamp: m.timestamp,
      fromMe: m.fromMe,
      from: m.from,
      to: m.to,
      hasMedia: m.hasMedia,
    }));

    res.json(formattedMessages);
  } catch (error) {
    console.error('获取消息失败:', error);
    res.status(500).json({ error: '获取消息失败', detail: error.message });
  }
});

// 发送消息
app.post('/send', async (req, res) => {
  try {
    if (!client || !client.info) {
      return res.status(503).json({ success: false, error: 'WhatsApp 未连接' });
    }

    const { to, message, mediaUrl } = req.body || {};
    const toId = normalizeTo(to);

    if (!toId) {
      return res.status(400).json({ success: false, error: '参数 to 无效' });
    }
    if (!message && !mediaUrl) {
      return res.status(400).json({ success: false, error: 'message 或 mediaUrl 至少提供一个' });
    }

    console.log('📤 Sending message to:', toId);

    let result;
    if (mediaUrl) {
      const media = await MessageMedia.fromUrl(mediaUrl);
      // caption 可选
      result = await client.sendMessage(toId, media, message ? { caption: message } : undefined);
    } else {
      result = await client.sendMessage(toId, String(message));
    }

    res.json({
      success: true,
      messageId: result?.id?._serialized || null,
    });
  } catch (error) {
    console.error('Send error:', error);
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

// 统一错误处理（放最后）
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err);
  res.status(500).json({ error: 'Internal Server Error', detail: err?.message });
});

// ============ 启动服务 ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Web 服务已启动，端口: ${PORT}`);
  console.log('📡 正在初始化 WhatsApp 客户端...');
  client.initialize().catch((e) => console.error('初始化失败:', e));
});

// 优雅关闭
process.on('SIGINT', async () => {
  try {
    console.log('🛑 正在关闭服务...');
    await client.destroy();
  } catch (e) {
    console.error('关闭时出错:', e);
  } finally {
    process.exit(0);
  }
});
