const { RequestValidator } = require('../utils/validators');
const { catchAsync } = require('../utils/errorHandler');

const validationMiddleware = {
    validateProfileCommand: catchAsync(async (req, res, next) => {
        RequestValidator.validateProfileCommand(req);
        next();
    }),

    validatePlaylistRequest: catchAsync(async (req, res, next) => {
        RequestValidator.validatePlaylistRequest(req);
        next();
    }),

    validateShowRequest: catchAsync(async (req, res, next) => {
        if (req.params.showUrl) {
            RequestValidator.validateShowRequest(req.params.showUrl);
        }
        next();
    }),

    validateTemplateRequest: catchAsync(async (req, res, next) => {
        if (req.params.templateUrl) {
            RequestValidator.validateTemplateRequest(req.params.templateUrl);
        }
        next();
    })
};

module.exports = validationMiddleware;