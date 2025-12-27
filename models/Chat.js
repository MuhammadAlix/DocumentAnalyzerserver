const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Chat = sequelize.define('Chat', {
  title: { type: DataTypes.STRING, allowNull: false },
  context: { type: DataTypes.TEXT, allowNull: true },
});

module.exports = Chat;