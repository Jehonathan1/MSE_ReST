class AppError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}

const handleMSEError = (error) => {
    if (error.response) {
        const statusCode = error.response.status;
        const message = error.response.data?.message || 'MSE Server Error';
        return new AppError(message, statusCode);
    }
    return new AppError('Unable to connect to MSE server', 503);
};

const handleValidationError = (error) => {
    const message = Object.values(error.errors).map(err => err.message).join('. ');
    return new AppError(message, 400);
};

const handleXMLError = (error) => {
    return new AppError(`XML Processing Error: ${error.message}`, 400);
};

const handleDuplicateError = (error) => {
    return new AppError('Resource already exists with this identifier', 409);
};

const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    if (process.env.NODE_ENV === 'development') {
        return sendDevError(err, res);
    }

    return sendProdError(err, res);
};

const sendDevError = (err, res) => {
    res.status(err.statusCode).json({
        status: err.status,
        error: err,
        message: err.message,
        stack: err.stack
    });
};

const sendProdError = (err, res) => {
    // Operational, trusted error: send message to client
    if (err.isOperational) {
        return res.status(err.statusCode).json({
            status: err.status,
            message: err.message
        });
    }
    
    // Programming or other unknown error: don't leak error details
    console.error('ERROR 💥', err);
    res.status(500).json({
        status: 'error',
        message: 'Something went wrong!'
    });
};

// Async Handler wrapper to eliminate try-catch blocks
const catchAsync = fn => {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
};

// Custom request validator
const validateRequest = (schema) => {
    return (req, res, next) => {
        const { error } = schema.validate(req.body);
        if (error) {
            const message = error.details.map(detail => detail.message).join(', ');
            return next(new AppError(message, 400));
        }
        next();
    };
};

// Global error catcher for unhandled promises
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION! 💥 Shutting down...');
    console.error(err.name, err.message, err.stack);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
    console.error(err.name, err.message, err.stack);
    process.exit(1);
});

module.exports = {
    AppError,
    errorHandler,
    catchAsync,
    validateRequest,
    handleMSEError,
    handleValidationError,
    handleXMLError,
    handleDuplicateError
};