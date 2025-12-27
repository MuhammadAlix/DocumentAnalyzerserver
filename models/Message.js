const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Message = sequelize.define('Message', {
  role: { type: DataTypes.ENUM('user', 'ai'), allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
});

module.exports = Message;