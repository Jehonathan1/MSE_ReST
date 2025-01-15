require('dotenv').config();

module.exports = {
    // Server configuration
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    // MSE configuration
    MSE_HOST: process.env.MSE_HOST || 'http://localhost:8580',
    
    // Cache configuration
    CACHE_TTL: process.env.CACHE_TTL || 5 * 60 * 1000, // 5 minutes
    
    // API configuration
    API_TIMEOUT: process.env.API_TIMEOUT || 5000,
    
    // CORS configuration
    CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
    
    // Command types
    COMMAND_TYPES: {
        TAKE: 'take',
        CONTINUE: 'continue',
        OUT: 'out',
        CLEANUP: 'cleanup',
        INITIALIZE: 'initialize'
    }
};