/*
 * Shared helpers: response format, errors, query string parsing and body validation.
 */
var mongoose = require('mongoose');

// An error that is safe to show to the client, with its HTTP status code
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function badRequest(message) {
    return new ApiError(400, message);
}

function notFound(message) {
    return new ApiError(404, message);
}

// Every response is { message, data }
function send(res, status, message, data) {
    res.status(status).json({ message: message, data: data });
}

// A 24 character hex string, which is how ids are written in URLs and bodies
function isObjectId(value) {
    return typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);
}

// Run fn in a transaction so that a failure part way through changes nothing
async function inTransaction(fn) {
    var result;
    await mongoose.connection.transaction(async function () {
        result = await fn();
    });
    return result;
}

/* ---------- Query string parameters ---------- */

function readParam(query, key) {
    var raw = query[key];
    if (raw !== undefined && typeof raw !== 'string') {
        throw badRequest('Query parameter "' + key + '" may only be given once');
    }
    return raw;
}

function parseJsonParam(query, key) {
    var raw = readParam(query, key);
    if (raw === undefined) return undefined;
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw badRequest('Query parameter "' + key + '" must be valid JSON');
    }
}

function parseObjectParam(query, key) {
    var value = parseJsonParam(query, key);
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        throw badRequest('Query parameter "' + key + '" must be a JSON object');
    }
    return value;
}

function parseIntegerParam(query, key) {
    var value = parseJsonParam(query, key);
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
        throw badRequest('Query parameter "' + key + '" must be a non-negative integer');
    }
    return value;
}

function parseBooleanParam(query, key) {
    var raw = readParam(query, key);
    if (raw === undefined) return false;
    var value = raw.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw badRequest('Query parameter "' + key + '" must be true or false');
}

// Errors from running a client-supplied query are the client's fault (400),
// unless the database could not be reached at all (500)
function isQueryError(err) {
    if (err instanceof mongoose.Error.CastError || err instanceof mongoose.Error.StrictModeError) return true;
    return err.name === 'MongoServerError';
}

async function runQuery(query) {
    try {
        return await query;
    } catch (err) {
        if (isQueryError(err)) throw badRequest('The query parameters are not valid for this collection');
        throw err;
    }
}

// GET on a collection: where, sort, select, skip, limit, count
async function listDocuments(Model, query, defaultLimit) {
    var where = parseObjectParam(query, 'where') || {};
    var sort = parseObjectParam(query, 'sort');
    var select = parseObjectParam(query, 'select');
    var skip = parseIntegerParam(query, 'skip');
    var limit = parseIntegerParam(query, 'limit');
    var count = parseBooleanParam(query, 'count');

    var q;
    try {
        if (count) {
            q = Model.countDocuments(where);
            if (skip !== undefined) q.skip(skip);
            if (limit !== undefined) q.limit(limit);
        } else {
            q = Model.find(where);
            if (sort) q.sort(sort);
            if (select) q.select(select);
            if (skip !== undefined) q.skip(skip);
            if (limit === undefined) limit = defaultLimit;
            if (limit) q.limit(limit);
            q.lean();
        }
    } catch (err) {
        throw badRequest('The query parameters are not valid for this collection');
    }
    return runQuery(q);
}

// GET on a single resource: only select applies
async function findOneById(Model, id, query, label) {
    var missing = notFound(label + ' not found');
    if (!isObjectId(id)) throw missing;

    var select;
    try {
        select = parseObjectParam(query, 'select');
    } catch (err) {
        // A missing resource takes precedence over a bad parameter
        if (!(await Model.exists({ _id: id }))) throw missing;
        throw err;
    }

    var q = Model.findById(id);
    if (select) {
        try {
            q.select(select);
        } catch (err) {
            throw badRequest('Query parameter "select" is not valid');
        }
    }
    var doc = await runQuery(q.lean());
    if (!doc) throw missing;
    return doc;
}

/* ---------- Request body fields ---------- */

function isFormRequest(req) {
    return Boolean(req.is('application/x-www-form-urlencoded'));
}

function isBlank(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function requiredString(body, field) {
    var value = body[field];
    if (isBlank(value)) throw badRequest('"' + field + '" is required');
    if (typeof value !== 'string') throw badRequest('"' + field + '" must be a string');
    return value;
}

function optionalString(body, field, fallback) {
    var value = body[field];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') throw badRequest('"' + field + '" must be a string');
    return value;
}

function requiredDate(body, field) {
    var value = body[field];
    if (isBlank(value)) throw badRequest('"' + field + '" is required');
    var date;
    if (typeof value === 'number') {
        date = new Date(value);
    } else if (typeof value === 'string') {
        // Form bodies send timestamps as strings
        date = /^-?\d+$/.test(value.trim()) ? new Date(Number(value)) : new Date(value);
    } else {
        throw badRequest('"' + field + '" must be a date');
    }
    if (isNaN(date.getTime())) throw badRequest('"' + field + '" must be a valid date');
    return date;
}

function optionalBoolean(body, field, fallback) {
    var value = body[field];
    if (isBlank(value)) return fallback;
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw badRequest('"' + field + '" must be true or false');
}

// A list of ids, normalized to lowercase and without duplicates
function idList(req, field, label) {
    var value = (req.body || {})[field];
    if (value === undefined || value === null) return [];
    if (typeof value === 'string' && isFormRequest(req)) {
        // A form can only send a single value, or a JSON encoded list
        var text = value.trim();
        if (text === '') {
            value = [];
        } else if (text.startsWith('[')) {
            try { value = JSON.parse(text); } catch (e) { /* checked below */ }
        } else {
            value = [text];
        }
    }
    if (!Array.isArray(value)) throw badRequest('"' + field + '" must be a list of ' + label + ' ids');
    value.forEach(function (id) {
        if (!isObjectId(id)) throw badRequest('"' + id + '" in "' + field + '" is not a valid ' + label + ' id');
    });
    return Array.from(new Set(value.map(function (id) { return id.toLowerCase(); })));
}

module.exports = {
    ApiError: ApiError,
    badRequest: badRequest,
    notFound: notFound,
    send: send,
    isObjectId: isObjectId,
    inTransaction: inTransaction,
    listDocuments: listDocuments,
    findOneById: findOneById,
    requiredString: requiredString,
    optionalString: optionalString,
    requiredDate: requiredDate,
    optionalBoolean: optionalBoolean,
    idList: idList
};
