var mongoose = require('mongoose');
var utils = require('./utils');

/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    app.use('/api', require('./home.js')(router));
    app.use('/api', require('./users.js')());
    app.use('/api', require('./tasks.js')());

    // Unknown endpoints
    app.use(function (req, res) {
        utils.send(res, 404, 'Endpoint not found', {});
    });

    // Turn every error into a { message, data } response without leaking database details
    app.use(function (err, req, res, next) {
        if (err instanceof utils.ApiError) {
            return utils.send(res, err.status, err.message, {});
        }
        if (err.type === 'entity.parse.failed') {
            return utils.send(res, 400, 'The request body is not valid JSON', {});
        }
        if (err.code === 11000) {
            // email is the only unique field
            return utils.send(res, 400, 'A user with this email already exists', {});
        }
        if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
            return utils.send(res, 400, 'The request contains an invalid value', {});
        }
        console.error(err);
        utils.send(res, 500, 'Something went wrong on the server, please try again later', {});
    });
};
