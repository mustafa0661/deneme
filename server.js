const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Express uygulaması oluştur
const app = express();
const server = http.createServer(app);

// Firebase kimlik bilgilerini dosyadan yükle
// Ana dizinde "firebase-credentials.json" dosyası olmalı
const serviceAccountPath = path.join(__dirname, 'firebase-credentials.json');
let serviceAccount;

try {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    console.log('Firebase kimlik bilgileri başarıyla yüklendi');
} catch (error) {
    console.error('Firebase kimlik bilgileri yüklenemedi:', error);
    process.exit(1);
}

// Firebase Admin SDK'yı başlat
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Middleware
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization", "User-Agent"]
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Gönderilen mesajları takip etmek için basit bir in-memory depo
const sentMessages = new Map();
const deliveredMessages = new Map();
const connectedClients = new Map();
const pendingMessages = new Map(); // Offline clients için mesaj kuyruğu

// Socket.IO sunucusu - geliştirilmiş ayarlar ve CORS desteği ile
const io = socketIO(server, {
    cors: {
        origin: "*", // Tüm kökenlere izin ver
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type", "Authorization", "User-Agent"],
        credentials: true
    },
    pingTimeout: 60000, // 60 saniye ping timeout
    pingInterval: 25000, // 25 saniye ping aralığı
    connectTimeout: 30000 // 30 saniye bağlantı zaman aşımı
});

// Socket.io bağlantı yönetimi
io.on('connection', (socket) => {
    const clientId = socket.id;
    const clientIP = socket.handshake.address;
    const userAgent = socket.handshake.headers['user-agent'] || 'Bilinmiyor';
    
    console.log(`Yeni bir istemci bağlandı: ${clientId}`);
    console.log(`IP: ${clientIP}, User-Agent: ${userAgent}`);
    
    // Client bilgilerini sakla
    connectedClients.set(clientId, {
        id: clientId,
        ip: clientIP,
        userAgent: userAgent,
        connectedAt: new Date(),
        lastActivity: new Date()
    });
    
    // Yeni bağlantı bildirimi
    socket.broadcast.emit('client-connected', { 
        clientId, 
        count: connectedClients.size 
    });
    
    // Local backend'den gelen kullanıcı kayıt isteği
    socket.on('register-user', async (userData, callback) => {
        try {
            // Aktivite zamanını güncelle
            updateClientActivity(clientId);
            
            // İstek doğrulama
            if (!userData.email || !userData.token) {
                console.error('Eksik veri:', userData);
                if (callback) {
                    callback({
                        success: false,
                        message: 'Email ve token zorunludur'
                    });
                }
                return;
            }

            console.log(`Kullanıcı kayıt isteği alındı: ${userData.email}`);
            
            // Tüm local client'lara yayınla
            io.emit('register-user-http', userData);
            
            // Callback varsa yanıt gönder
            if (callback) {
                callback({
                    success: true,
                    message: 'Kullanıcı kaydı alındı, tüm istemcilere yayınlandı'
                });
            }
        } catch (error) {
            console.error('Kullanıcı kayıt hatası:', error);
            if (callback) {
                callback({
                    success: false,
                    message: error.message
                });
            }
        }
    });

    // Local backend'den gelen token güncelleme isteği
    socket.on('update-token', async (updateData, callback) => {
        try {
            // Aktivite zamanını güncelle
            updateClientActivity(clientId);
            
            // İstek doğrulama
            if (!updateData.email || !updateData.token) {
                console.error('Eksik token verisi:', updateData);
                if (callback) {
                    callback({
                        success: false,
                        message: 'Email ve token zorunludur'
                    });
                }
                return;
            }

            console.log(`Token güncelleme isteği alındı: ${updateData.email}`);
            
            // Tüm local client'lara yayınla
            io.emit('update-token-http', updateData);
            
            // Callback varsa yanıt gönder
            if (callback) {
                callback({
                    success: true,
                    message: 'Token güncelleme isteği alındı ve tüm istemcilere yayınlandı'
                });
            }
        } catch (error) {
            console.error('Token güncelleme hatası:', error);
            if (callback) {
                callback({
                    success: false,
                    message: error.message
                });
            }
        }
    });

    // Local backend'den gelen 'send-notification' olayını dinle
    socket.on('send-notification', async (notificationData, callback) => {
        try {
            // Aktivite zamanını güncelle
            updateClientActivity(clientId);
            
            console.log('Bildirim gönderme isteği alındı:', notificationData);
            
            const { type, target, title, body, data } = notificationData;

            // İstek doğrulama
            if (!type || !target || !title || !body) {
                const error = { message: 'Eksik bilgi içeren bildirim isteği' };
                console.error(error.message, notificationData);
                
                // Hata yanıtı
                socket.emit('notification-error', error);
                if (callback) callback({ success: false, ...error });
                return;
            }

            // Benzersiz bir mesaj ID oluştur (yoksa)
            const messageId = data?.messageId || uuidv4();

            // Mesaj verilerini hazırla
            const message = {
                notification: {
                    title,
                    body
                },
                data: {
                    ...(data || {}),
                    message_id: messageId,
                    timestamp: new Date().toISOString()
                },
                android: {
                    priority: 'high',
                    notification: {
                        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                        channelId: 'high_importance_channel'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            contentAvailable: true,
                            badge: 1,
                            sound: 'default'
                        }
                    },
                    headers: {
                        'apns-priority': '10'
                    }
                }
            };

            // Token bazlı veya topic bazlı gönderim
            let result;

            try {
                if (type === 'token') {
                    // Token bazlı gönderim
                    message.token = target;
                    result = await admin.messaging().send(message);
                } else if (type === 'topic') {
                    // Topic bazlı gönderim
                    message.topic = target;
                    result = await admin.messaging().send(message);
                } else {
                    const error = { message: 'Geçersiz gönderim tipi' };
                    socket.emit('notification-error', error);
                    if (callback) callback({ success: false, ...error });
                    return;
                }
            } catch (fcmError) {
                console.error('FCM gönderim hatası:', fcmError);
                
                const error = { 
                    message: fcmError.message,
                    code: fcmError.code,
                    details: fcmError.errorInfo
                };
                
                socket.emit('notification-error', error);
                if (callback) callback({ success: false, ...error });
                return;
            }

            // Başarılı yanıt
            console.log('Bildirim başarıyla gönderildi:', result);

            // Mesaj kaydını tut
            const messageRecord = {
                ...notificationData,
                sentAt: new Date(),
                messageId,
                result
            };
            
            sentMessages.set(messageId, messageRecord);

            // Tüm bağlı istemcilere bildir
            io.emit('notification-sent', {
                success: true,
                messageId,
                result,
                sentAt: new Date().toISOString()
            });
            
            // İstekte bulunan istemciye özel yanıt
            if (callback) {
                callback({
                    success: true,
                    messageId,
                    result
                });
            }
        } catch (error) {
            console.error('Bildirim gönderilirken genel hata oluştu:', error);
            socket.emit('notification-error', {
                message: error.message,
                code: error.code || 'UNKNOWN_ERROR'
            });
            
            if (callback) {
                callback({
                    success: false,
                    message: error.message,
                    code: error.code || 'UNKNOWN_ERROR'
                });
            }
        }
    });

    // Teslim onayı etkinliğini dinle
    socket.on('delivery-confirmation', (data) => {
        // Aktivite zamanını güncelle
        updateClientActivity(clientId);
        
        const { messageId } = data;

        if (!messageId) {
            socket.emit('confirmation-error', { message: 'MessageId gereklidir' });
            return;
        }

        const message = sentMessages.get(messageId);

        if (!message) {
            socket.emit('confirmation-error', { message: 'Bu ID ile mesaj bulunamadı' });
            return;
        }

        // Teslim zamanını kaydet
        deliveredMessages.set(messageId, {
            ...message,
            deliveredAt: new Date()
        });

        console.log(`Mesaj teslim edildi: ${messageId}`);
        socket.emit('confirmation-success', { messageId });
        
        // Tüm istemcilere bildir
        io.emit('message-delivered', { 
            messageId, 
            deliveredAt: new Date().toISOString() 
        });
    });

    // Local backend'den kullanıcı listesi isteği
    socket.on('get-users', (data, callback) => {
        // Aktivite zamanını güncelle
        updateClientActivity(clientId);
        
        // Bu istek socket.io üzerinden local backend'e iletilecek
        console.log('Kullanıcı listesi isteniyor, istek tüm local istemcilere iletildi');
        
        // Tüm istemcilere yayınla
        socket.broadcast.emit('get-users-request', { requesterId: clientId });
        
        if (callback) {
            callback({
                success: true,
                message: 'Kullanıcı verileri isteği gönderildi'
            });
        }
    });
    
    // Local backend'den gelen kullanıcı listesi yanıtı
    socket.on('users-response', (userData) => {
        // Aktivite zamanını güncelle
        updateClientActivity(clientId);
        
        const { requesterId, users } = userData;
        
        // İstek sahibine doğrudan yanıt ver
        if (requesterId && io.sockets.sockets.has(requesterId)) {
            io.to(requesterId).emit('users-data', { 
                users, 
                source: socket.id 
            });
            console.log(`Kullanıcı verisi ${requesterId} istemcisine iletildi`);
        }
    });
    
    // Canlılık kontrolü
    socket.on('ping', (data, callback) => {
        // Aktivite zamanını güncelle
        updateClientActivity(clientId);
        
        const responseData = { 
            time: new Date().toISOString(),
            serverTime: Date.now(),
            clientsCount: connectedClients.size
        };
        
        // Socket.io 'callback' ile cevap ver (varsa)
        if (callback && typeof callback === 'function') {
            callback(responseData);
        } else {
            // Yoksa 'pong' olayıyla cevap ver
            socket.emit('pong', responseData);
        }
    });
    
    // Local backend'den gelen mesaj olayı
    socket.on('message', (message) => {
        // Aktivite zamanını güncelle
        updateClientActivity(clientId);
        
        console.log(`Mesaj alındı (${clientId}): ${message}`);
        
        // Echo yanıtı gönder
        socket.emit('message-echo', {
            original: message,
            time: new Date().toISOString(),
            echo: `Echo: ${message}`
        });
        
        // Server zamanını gönder (örnek)
        socket.emit('server-time', new Date().toISOString());
    });

    // Bağlantı kesildiğinde
    socket.on('disconnect', () => {
        console.log('İstemci bağlantısı kesildi:', clientId);
        
        // Client kaydını sil
        connectedClients.delete(clientId);
        
        // Diğer istemcilere bildir
        socket.broadcast.emit('client-disconnected', { 
            clientId, 
            count: connectedClients.size 
        });
    });
});

// Client aktivitesini güncelle
function updateClientActivity(clientId) {
    if (connectedClients.has(clientId)) {
        const client = connectedClients.get(clientId);
        client.lastActivity = new Date();
        connectedClients.set(clientId, client);
    }
}

// API Routes - Artık çoğu işlem Socket.IO üzerinden yapılacak

// Android uygulamasından gelen register isteğini işle
app.post('/api/register', async (req, res) => {
    try {
        const userData = req.body;
        
        // İstek doğrulama
        if (!userData.email || !userData.token) {
            return res.status(400).json({
                success: false,
                message: 'Email ve token zorunludur'
            });
        }

        // Socket.IO ile tüm bağlı local backend'lere bildirim
        io.emit('register-user-http', userData);
        console.log(`API üzerinden kullanıcı kaydı alındı ve yayınlandı: ${userData.email}`);

        // Kullanıcıya başarılı yanıt ver
        return res.status(200).json({
            success: true,
            message: 'Kayıt isteği alındı ve işleme konuldu'
        });
    } catch (error) {
        console.error('Kullanıcı kayıt hatası:', error);
        return res.status(500).json({
            success: false,
            message: 'Sunucu hatası',
            error: error.message
        });
    }
});

// Token güncelleme isteğini işle
app.post('/api/update-token', async (req, res) => {
    try {
        const updateData = req.body;
        
        // İstek doğrulama
        if (!updateData.email || !updateData.token) {
            return res.status(400).json({
                success: false,
                message: 'Email ve token zorunludur'
            });
        }

        // Socket.IO ile tüm local backend'lere bildirim
        io.emit('update-token-http', updateData);
        console.log(`API üzerinden token güncelleme alındı ve yayınlandı: ${updateData.email}`);

        return res.status(200).json({
            success: true,
            message: 'Token güncelleme isteği alındı'
        });
    } catch (error) {
        console.error('Token güncelleme hatası:', error);
        return res.status(500).json({
            success: false,
            message: 'Sunucu hatası',
            error: error.message
        });
    }
});

// Bildirim gönderme
app.post('/api/send-notification', async (req, res) => {
    try {
        const notificationData = req.body;
        
        // İstek doğrulama
        if (!notificationData.type || !notificationData.target || !notificationData.title || !notificationData.body) {
            return res.status(400).json({
                success: false,
                message: 'Type, target, title ve body alanları zorunludur'
            });
        }

        // Benzersiz bir mesaj ID oluştur
        const messageId = notificationData.data?.messageId || uuidv4();
        
        // Mesaj verilerini hazırla
        const message = {
            notification: {
                title: notificationData.title,
                body: notificationData.body
            },
            data: {
                ...(notificationData.data || {}),
                message_id: messageId,
                timestamp: new Date().toISOString()
            },
            android: {
                priority: 'high',
                notification: {
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                    channelId: 'high_importance_channel'
                }
            },
            apns: {
                payload: {
                    aps: {
                        contentAvailable: true,
                        badge: 1,
                        sound: 'default'
                    }
                },
                headers: {
                    'apns-priority': '10'
                }
            }
        };

        // Token bazlı veya topic bazlı gönderim
        let result;

        try {
            if (notificationData.type === 'token') {
                // Token bazlı gönderim
                message.token = notificationData.target;
                result = await admin.messaging().send(message);
            } else if (notificationData.type === 'topic') {
                // Topic bazlı gönderim
                message.topic = notificationData.target;
                result = await admin.messaging().send(message);
            } else {
                return res.status(400).json({
                    success: false,
                    message: 'Geçersiz gönderim tipi'
                });
            }
        } catch (fcmError) {
            console.error('FCM gönderim hatası:', fcmError);
            return res.status(500).json({
                success: false,
                message: fcmError.message,
                code: fcmError.code,
                details: fcmError.errorInfo
            });
        }

        // Başarılı yanıt
        console.log('API üzerinden bildirim başarıyla gönderildi:', result);

        // Mesaj kaydını tut
        sentMessages.set(messageId, {
            ...notificationData,
            sentAt: new Date(),
            messageId,
            result
        });

        // Tüm bağlı istemcilere bildir
        io.emit('notification-sent', {
            success: true,
            messageId,
            result,
            sentAt: new Date().toISOString()
        });

        return res.status(200).json({
            success: true,
            messageId,
            result
        });
    } catch (error) {
        console.error('API bildirim hatası:', error);
        return res.status(500).json({
            success: false,
            message: 'Sunucu hatası',
            error: error.message
        });
    }
});

// Teslim onayı - Doğrudan Render backend'inde işlenir
app.post('/api/confirm-delivery', async (req, res) => {
    try {
        const { messageId } = req.body;

        if (!messageId) {
            return res.status(400).json({
                success: false,
                message: 'Message ID zorunludur'
            });
        }

        const message = sentMessages.get(messageId);

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Bu ID ile mesaj bulunamadı'
            });
        }

        // Teslim zamanını kaydet
        deliveredMessages.set(messageId, {
            ...message,
            deliveredAt: new Date()
        });

        console.log(`API üzerinden mesaj teslim onayı alındı: ${messageId}`);

        // Tüm bağlı istemcilere bildir
        io.emit('message-delivered', { 
            messageId, 
            deliveredAt: new Date().toISOString() 
        });

        return res.status(200).json({
            success: true,
            message: 'Teslim onayı alındı'
        });
    } catch (error) {
        console.error('Teslim onayı hatası:', error);
        return res.status(500).json({
            success: false,
            message: 'Sunucu hatası',
            error: error.message
        });
    }
});

// Basit API endpoint'leri
app.get('/', (req, res) => {
    res.send('FCM Test Render Backend - Aktif');
});

// İstatistikler
app.get('/api/stats', (req, res) => {
    const data = {
        sentCount: sentMessages.size,
        deliveredCount: deliveredMessages.size,
        deliveryRate: sentMessages.size > 0 ? (deliveredMessages.size / sentMessages.size) * 100 : 0,
        connectedClients: connectedClients.size,
        clients: Array.from(connectedClients.values()).map(client => ({
            id: client.id,
            connectedAt: client.connectedAt,
            lastActivity: client.lastActivity
        })),
        uptime: process.uptime()
    };
    
    res.json(data);
});

// Son gönderilen mesajlar
app.get('/api/messages', (req, res) => {
    const messages = Array.from(sentMessages.values())
        .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))
        .slice(0, 50);  // Son 50 mesajı döndür

    res.json(messages);
});

// Canlılık kontrolü için endpoint
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Bağlı istemciler listesi
app.get('/api/clients', (req, res) => {
    const clients = Array.from(connectedClients.values()).map(client => ({
        id: client.id,
        ip: client.ip,
        userAgent: client.userAgent,
        connectedAt: client.connectedAt,
        lastActivity: client.lastActivity,
        idle: Date.now() - new Date(client.lastActivity).getTime()
    }));
    
    res.json({
        count: clients.length,
        clients
    });
});

// Node.js otomatik bellek temizliği için periyodik işlem
setInterval(() => {
    // İnaktif istemcileri kontrol et (30 dakika)
    const now = Date.now();
    const inactiveThreshold = 30 * 60 * 1000; // 30 dakika
    
    connectedClients.forEach((client, id) => {
        const lastActivity = new Date(client.lastActivity).getTime();
        if (now - lastActivity > inactiveThreshold) {
            console.log(`İnaktif istemci temizleniyor: ${id}`);
            connectedClients.delete(id);
            
            // Eğer socket hala açıksa强制关闭
            const socket = io.sockets.sockets.get(id);
            if (socket) {
                socket.disconnect(true);
            }
        }
    });
    
    // 24 saatten eski mesajları temizle
    const oldMessageThreshold = 24 * 60 * 60 * 1000; // 24 saat
    
    sentMessages.forEach((message, id) => {
        const sentAt = new Date(message.sentAt).getTime();
        if (now - sentAt > oldMessageThreshold) {
            sentMessages.delete(id);
            deliveredMessages.delete(id);
        }
    });
    
    // Bellek kullanımını logla
    const memoryUsage = process.memoryUsage();
    console.log('Bellek kullanımı:', {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`,
    });
}, 15 * 60 * 1000); // 15 dakikada bir çalıştır

// Dinlemeye başla
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`FCM Render Backend http://localhost:${PORT} adresinde çalışıyor`);
    console.log(`Node.js sürümü: ${process.version}`);
    console.log(`İşletim sistemi: ${process.platform}`);
});

// Hata yönetimi
process.on('uncaughtException', (error) => {
    console.error('Yakalanmayan istisna:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('İşlenmeyen söz reddi:', reason);
});

// Sunucu düzgün kapatma
process.on('SIGTERM', () => {
    console.log('SIGTERM sinyali alındı, server düzgün kapatılıyor...');
    
    io.close(() => {
        console.log('Socket.IO sunucusu kapatıldı');
        server.close(() => {
            console.log('HTTP sunucusu kapatıldı');
            process.exit(0);
        });
    });
});