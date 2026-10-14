var express = require('express');
var User = require('../models/user');
var Task = require('../models/task');
var utils = require('./utils');

// Validate the fields of a POST/PUT body that need no database lookup (400s)
function readTaskBody(req) {
    var body = req.body || {};
    var input = {
        name: utils.requiredString(body, 'name'),
        deadline: utils.requiredDate(body, 'deadline'),
        description: utils.optionalString(body, 'description', ''),
        completed: utils.optionalBoolean(body, 'completed', false),
        assignedUser: utils.optionalString(body, 'assignedUser', '').trim().toLowerCase(),
        assignedUserName: utils.optionalString(body, 'assignedUserName', '').trim()
    };
    if (input.assignedUser && !utils.isObjectId(input.assignedUser)) {
        throw utils.badRequest('"' + input.assignedUser + '" in "assignedUser" is not a valid user id');
    }
    if (!input.assignedUser && input.assignedUserName && input.assignedUserName !== 'unassigned') {
        throw utils.badRequest('"assignedUserName" is set but the task has no "assignedUser"');
    }
    return input;
}

// Look up the assigned user (404) and check that assignedUserName matches it (400)
async function resolveAssignee(input) {
    if (!input.assignedUser) {
        input.assignedUserName = 'unassigned';
        return;
    }
    var user = await User.findById(input.assignedUser).lean();
    if (!user) throw utils.notFound('Assigned user not found');
    if (input.assignedUserName && input.assignedUserName !== user.name) {
        throw utils.badRequest('"assignedUserName" does not match the name of the assigned user');
    }
    input.assignedUserName = user.name;
}

// Make the task appear in exactly the pendingTasks it belongs in
async function syncPendingTasks(task) {
    var taskId = String(task._id);
    var owner = task.assignedUser && !task.completed ? task.assignedUser : null;
    var others = { pendingTasks: taskId };
    if (owner) others._id = { $ne: owner };
    await User.updateMany(others, { $pull: { pendingTasks: taskId } });
    if (owner) await User.updateOne({ _id: owner }, { $addToSet: { pendingTasks: taskId } });
}

async function findTaskOr404(id) {
    var task = utils.isObjectId(id) ? await Task.findById(id) : null;
    if (!task) throw utils.notFound('Task not found');
    return task;
}

module.exports = function () {
    var router = express.Router();

    router.route('/tasks')
        .get(async function (req, res) {
            var data = await utils.listDocuments(Task, req.query, 100);
            utils.send(res, 200, 'OK', data);
        })
        .post(async function (req, res) {
            var input = readTaskBody(req);
            var task = await utils.inTransaction(async function () {
                await resolveAssignee(input);
                var created = await new Task(input).save();
                await syncPendingTasks(created);
                return created;
            });
            utils.send(res, 201, 'Task created', task);
        });

    router.route('/tasks/:id')
        .get(async function (req, res) {
            var task = await utils.findOneById(Task, req.params.id, req.query, 'Task');
            utils.send(res, 200, 'OK', task);
        })
        .put(async function (req, res) {
            var task = await utils.inTransaction(async function () {
                var existing = await findTaskOr404(req.params.id);
                var input = readTaskBody(req);
                await resolveAssignee(input);
                existing.set(input);
                await existing.save();
                await syncPendingTasks(existing);
                return existing;
            });
            utils.send(res, 200, 'Task updated', task);
        })
        .delete(async function (req, res) {
            var task = await utils.inTransaction(async function () {
                var existing = await findTaskOr404(req.params.id);
                await User.updateMany({ pendingTasks: String(existing._id) }, { $pull: { pendingTasks: String(existing._id) } });
                await existing.deleteOne();
                return existing;
            });
            utils.send(res, 200, 'Task deleted', task);
        });

    return router;
};
