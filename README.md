# WhatsApp Web 服务

这是一个用于与 Lovable 应用集成的 WhatsApp Web API 服务。

## 🚀 一键部署到 Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

## 📝 手动部署步骤

### 1. Fork 或复制这个仓库到你的 GitHub

### 2. 在 Railway 创建新项目

1. 访问 [railway.app](https://railway.app)
2. 点击 "New Project"
3. 选择 "Deploy from GitHub repo"
4. 选择这个仓库
5. 等待部署完成

### 3. 获取服务地址

部署完成后，点击 "Settings" → "Networking" → "Generate Domain"
复制生成的 URL（类似 `https://whatsapp-web-xxx.railway.app`）

### 4. 在 Lovable 应用中配置

1. 打开 Lovable 应用的 "WhatsApp Web" 页面
2. 将 Railway 服务地址粘贴到 "服务地址" 输入框
3. 点击 "刷新二维码"
4. 用手机 WhatsApp 扫描二维码登录
5. 启用 "自动回复" 开关

## 📡 API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/` | GET | 健康检查 |
| `/qr` | GET | 获取登录二维码 |
| `/status` | GET | 获取连接状态 |
| `/refresh-qr` | POST | 刷新二维码 |
| `/send` | POST | 发送消息 |
| `/webhook` | POST | 配置 Webhook |
| `/logout` | POST | 登出 |

## ⚠️ 注意事项

1. **手机需保持在线**：WhatsApp Web 需要手机在线才能工作
2. **勿频繁发送消息**：避免被 WhatsApp 封号
3. **Railway 计费**：免费额度用完后按使用量收费

## 🔧 本地开发

\`\`\`bash
npm install
npm start
\`\`\`

服务将在 `http://localhost:3000` 启动
