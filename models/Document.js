const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Document = sequelize.define('Document', {
  filename: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  fileType: {
    type: DataTypes.STRING,
  },
  extractedText: {
    type: DataTypes.TEXT,
  },
  aiResponse: {
    type: DataTypes.TEXT,
  }
});

module.exports = Document;
