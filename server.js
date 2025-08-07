// Server is running on TCP non-SSL, this is because I am
// running behind a proxy. Note the endpoint must be SSL for this to work

require('dotenv').config();
const mysql = require('mysql2/promise');
const http = require('http');
const WebSocket = require('ws');

// Initialize HTTP server
const server = http.createServer();

// Initialize WebSocket server
const wss = new WebSocket.Server({ server });

initializeConnection();

let locked = false;
let mutedUsers = new Set(); // Use a Set to store muted users
const messageLimit = 10; // Max messages allowed
const messageResetTime = 2000; // Time in ms to reset messages count
const userMessageCounts = new Map(); // Map to track user message counts

// Handle connections
wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (data) => {
        const message = parseJSON(data);
        if (!message || !message.session || !message.text) {
            return;
        }

        checkAccount(message.session).then(user => {
            if (!user) return;

            console.log(`Received message from ${user.name} => ${message.text}`);

            if (user.admin && user.admin == 'true' && message.text.startsWith('/')) {
                handleCommand(message.text, user.name, wss, ws);
            } else {
                // Rate limiting logic
                const userMessageCount = userMessageCounts.get(user.name) || { count: 0, lastReset: Date.now() };
                
                // Reset the count if the time limit has passed
                if (Date.now() - userMessageCount.lastReset > messageResetTime) {
                    userMessageCount.count = 0; // Reset count
                    userMessageCount.lastReset = Date.now(); // Update last reset time
                }

                if (userMessageCount.count < messageLimit && !locked && !mutedUsers.has(user.name)) {
                    userMessageCount.count++;
                    userMessageCounts.set(user.name, userMessageCount);
                    sendToAll(wss, JSON.stringify({ 'usr_from': user.name, 'message': message.text }));
                    uploadMessageToDB(user.name, message.text);
                } else if (userMessageCount.count >= messageLimit) {
                    ws.send(JSON.stringify({ 'usr_from': 'Auto Response', 'message': 'You are sending messages too quickly. Please wait.' }));
                } else if (mutedUsers.has(user.name)) {
                    ws.send(JSON.stringify({ 'usr_from': 'Auto Response', 'message': 'You are muted and cannot send messages.' }));
                } else {
                    if(user.admin && user.admin == 'true'){
                        userMessageCount.count++;
                        userMessageCounts.set(user.name, userMessageCount);
                        sendToAll(wss, JSON.stringify({ 'usr_from': user.name, 'message': message.text }));
                        uploadMessageToDB(user.name, message.text);
                    } else{
                        ws.send(JSON.stringify({ 'usr_from': 'Auto Response', 'message': 'The chat is currently locked by an admin' }));
                    }
                }
            }
        });
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

function sendToAll(wss, message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function handleCommand(command, userName, wss, ws) {
    const [cmd, arg] = command.split(' ');

    if (cmd === '/lock' || cmd === '/unlock') {
        locked = !locked;
        const responseMessage = locked 
            ? 'Chat locked by an admin' 
            : 'Chat unlocked by an admin';
        uploadMessageToDB('Auto Admin', responseMessage);
        sendToAll(wss, JSON.stringify({ 'usr_from': 'Auto Admin', 'message': responseMessage }));
    } else if (cmd === '/mute' && arg) {
        mutedUsers.add(arg);
        uploadMessageToDB('Auto Admin', `${arg} has been muted by ${userName}.`);
        sendToAll(wss, JSON.stringify({ 'usr_from': 'Auto Admin', 'message': `${arg} has been muted by ${userName}.` }));
    } else if (cmd === '/unmute' && arg) {
        mutedUsers.delete(arg);
        uploadMessageToDB('Auto Admin', `${arg} has been unmuted by ${userName}.`);
        sendToAll(wss, JSON.stringify({ 'usr_from': 'Auto Admin', 'message': `${arg} has been unmuted by ${userName}.` }));
    } else if (cmd === '/panic') {
        uploadMessageToDB('Auto Admin', `${userName} has triggered a global panic.`);
        sendToAll(wss, JSON.stringify({ 'usr_from': 'PANIC', 'message': `PANIC` }));
    } else if (cmd === '/help') {
        ws.send(JSON.stringify({ 'usr_from': 'Auto Response', 'message': `/lock, /mute USERNAME (caps do matter), /unmute USERNAME (caps do matter), /panic, /clear` }));
    } else if (cmd === '/clear') {
        hideAllMessages();

        uploadMessageToDB('Auto Admin', `${userName} has triggered a clear.`);
        sendToAll(wss, JSON.stringify({ 'usr_from': 'CLEAR', 'message': `CLEAR` }));
        sendToAll(wss, JSON.stringify({ 'usr_from': 'Auto Admin', 'message': `${userName} has triggered a clear.` }));
    }
}

let connection;

async function initializeConnection(retries = 5, delay = 2000) {
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST.split(':')[0],
            port: process.env.DB_HOST.split(':')[1],
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
        });
        console.log('Database connection established.');
        
        // Handle unexpected disconnections
        connection.on('error', async (err) => {
            if (err.code === 'PROTOCOL_CONNECTION_LOST') {
                console.error('Database connection lost. Attempting to reconnect...');
                await reconnect();
            } else {
                console.error('Database error:', err);
                throw err;
            }
        });
    } catch (error) {
        console.error('Error establishing database connection:', error);
        if (retries > 0) {
            console.log(`Retrying in ${delay / 1000} seconds... (${retries} retries left)`);
            setTimeout(() => initializeConnection(retries - 1, delay), delay);
        } else {
            throw error;
        }
    }
}

async function reconnect(retries = 5, delay = 2000) {
    if (retries <= 0) {
        console.error('Could not reconnect to the database after multiple attempts.');
        return;
    }

    try {
        await connection.end(); // Clean up previous connection
        await initializeConnection();
        console.log('Reconnected to the database.');
    } catch (error) {
        console.error('Reconnection failed. Retrying...', error);
        setTimeout(() => reconnect(retries - 1, delay), delay);
    }
}

async function checkAccount(session) {
    try {
        const [rows] = await connection.execute('SELECT *, additional_values FROM accounts WHERE session = ?', [session]);
        return rows.length > 0 ? parseJSON(rows[0]['additional_values']) : false;
    } catch (error) {
        console.error('Error querying the database:', error);
        if (error.code === 'PROTOCOL_CONNECTION_LOST') {
            await reconnect();
        }
        return null;
    }
}

async function uploadMessageToDB(userName, message) {
    try {
        await connection.execute('INSERT INTO messages (usr_from, message) VALUES (?, ?)', [userName, message]);
        console.log('Message uploaded to DB:', { usr_from: userName, message });
    } catch (error) {
        console.error('Error uploading message to DB:', error);
        if (error.code === 'PROTOCOL_CONNECTION_LOST') {
            await reconnect();
        }
    }
}

async function hideAllMessages() {
    try {
        await connection.execute('UPDATE messages SET visible = 0');
        console.log('All messages set to hidden.');
    } catch (error) {
        console.error('Error updating messages:', error);
        if (error.code === 'PROTOCOL_CONNECTION_LOST') {
            await reconnect();
        }
    }
}


function parseJSON(jsonString) {
    try {
        return JSON.parse(jsonString);
    } catch {
        return null; // Return null if parsing fails
    }
}

// Start the server
server.listen(1026, () => {
    console.log('WebSocket server is running on wss://chat-v1-api.mjdawson.net');
});
