// server/models/index.js
const sequelize = require('../config/database');
const User = require('./User');
const Chat = require('./Chat');
const Message = require('./Message');
const Document = require('./Document');


User.hasMany(Chat, { onDelete: 'CASCADE' });
Chat.belongsTo(User);

Chat.hasMany(Message, { onDelete: 'CASCADE' });
Message.belongsTo(Chat);

module.exports = { sequelize, User, Chat, Message, Document };