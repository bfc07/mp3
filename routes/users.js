var express = require('express');
var User = require('../models/user');
var Task = require('../models/task');
var utils = require('./utils');

var UNASSIGNED = { assignedUser: '', assignedUserName: 'unassigned' };

// Validate the fields of a POST/PUT body that need no database lookup (400s)
function readUserBody(req) {
    var body = req.body || {};
    var email = utils.requiredString(body, 'email').trim();
    var name = utils.requiredString(body, 'name');
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw utils.badRequest('"email" must be a valid email address');
    return {
        name: name,
        email: email,
        pendingTasks: utils.idList(req, 'pendingTasks', 'task')
    };
}

// Checks against the database, in the order: email in use (400), unknown tasks (404), completed tasks (400)
async function checkUserReferences(input, userId) {
    var sameEmail = { email: input.email };
    if (userId) sameEmail._id = { $ne: userId };
    var taken = await User.findOne(sameEmail).collation({ locale: 'en', strength: 2 }).lean();
    if (taken) throw utils.badRequest('A user with this email already exists');

    if (input.pendingTasks.length === 0) return;
    var tasks = await Task.find({ _id: { $in: input.pendingTasks } }).lean();
    var found = new Set(tasks.map(function (task) { return String(task._id); }));
    var missing = input.pendingTasks.filter(function (id) { return !found.has(id); });
    if (missing.length) throw utils.notFound('Task not found: ' + missing.join(', '));
    var completed = tasks.filter(function (task) { return task.completed; });
    if (completed.length) {
        throw utils.badRequest('Completed tasks cannot be pending: ' + completed.map(function (t) { return t._id; }).join(', '));
    }
}

// Assign the user's pendingTasks to them, taking the tasks away from any other user
async function claimTasks(user) {
    var userId = String(user._id);
    var taskIds = user.pendingTasks;
    if (taskIds.length) {
        await User.updateMany(
            { _id: { $ne: userId }, pendingTasks: { $in: taskIds } },
            { $pull: { pendingTasks: { $in: taskIds } } }
        );
        await Task.updateMany(
            { _id: { $in: taskIds } },
            { $set: { assignedUser: userId, assignedUserName: user.name } }
        );
    }
    // Tasks that stay with the user (completed ones too) follow a name change
    await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: user.name } });
}

async function findUserOr404(id) {
    var user = utils.isObjectId(id) ? await User.findById(id) : null;
    if (!user) throw utils.notFound('User not found');
    return user;
}

module.exports = function () {
    var router = express.Router();

    router.route('/users')
        .get(async function (req, res) {
            var data = await utils.listDocuments(User, req.query, 0);
            utils.send(res, 200, 'OK', data);
        })
        .post(async function (req, res) {
            var input = readUserBody(req);
            var user = await utils.inTransaction(async function () {
                await checkUserReferences(input, null);
                var created = await new User(input).save();
                await claimTasks(created);
                return created;
            });
            utils.send(res, 201, 'User created', user);
        });

    router.route('/users/:id')
        .get(async function (req, res) {
            var user = await utils.findOneById(User, req.params.id, req.query, 'User');
            utils.send(res, 200, 'OK', user);
        })
        .put(async function (req, res) {
            var user = await utils.inTransaction(async function () {
                var existing = await findUserOr404(req.params.id);
                var input = readUserBody(req);
                await checkUserReferences(input, existing._id);

                // Pending tasks the user no longer lists become unassigned
                await Task.updateMany(
                    { assignedUser: String(existing._id), completed: false, _id: { $nin: input.pendingTasks } },
                    { $set: UNASSIGNED }
                );
                existing.set(input);
                await existing.save();
                await claimTasks(existing);
                return existing;
            });
            utils.send(res, 200, 'User updated', user);
        })
        .delete(async function (req, res) {
            await utils.inTransaction(async function () {
                var existing = await findUserOr404(req.params.id);
                await Task.updateMany({ assignedUser: String(existing._id) }, { $set: UNASSIGNED });
                await existing.deleteOne();
            });
            // 204 No Content: nothing left to send back
            res.status(204).end();
        });

    return router;
};
