const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseTaskID = (req) => asNonEmptyString(req?.params?.taskId);

const sendServiceError = (res, error, fallback) => {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({
      error: error.message,
      ...(error.task ? { task: error.task } : {}),
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: `${fallback}.` });
};

export const registerScheduledTaskRoutes = (app, dependencies) => {
  const {
    getOpenChamberEventClients,
    writeSseEvent,
    scheduledTaskService,
  } = dependencies;

  app.get('/api/openchamber/scheduled-tasks', async (_req, res) => {
    try {
      const tasks = await scheduledTaskService.list();
      return res.json({ tasks });
    } catch (error) {
      return sendServiceError(res, error, '[ScheduledTasks] failed to load tasks:');
    }
  });

  app.post('/api/openchamber/scheduled-tasks', async (req, res) => {
    const location = asNonEmptyString(req.body?.location);
    const taskInput = req.body && typeof req.body === 'object' ? req.body.task : null;
    if (!location) {
      return res.status(400).json({ error: 'location must be local or shared' });
    }
    if (!taskInput || typeof taskInput !== 'object') {
      return res.status(400).json({ error: 'task payload is required' });
    }

    try {
      const result = await scheduledTaskService.create({ location, task: taskInput });
      return res.status(201).json(result);
    } catch (error) {
      return sendServiceError(res, error, '[ScheduledTasks] failed to create task:');
    }
  });

  app.patch('/api/openchamber/scheduled-tasks/:taskId/enabled', async (req, res) => {
    const taskID = parseTaskID(req);
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      const task = await scheduledTaskService.setLoopEnabled(taskID, req.body?.enabled);
      return res.json({ task });
    } catch (error) {
      return sendServiceError(res, error, '[ScheduledTasks] failed to update loop file:');
    }
  });

  app.delete('/api/openchamber/scheduled-tasks/:taskId', async (req, res) => {
    const taskID = parseTaskID(req);
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json({ tasks: await scheduledTaskService.removeLoopFile(taskID) });
    } catch (error) {
      return sendServiceError(res, error, '[ScheduledTasks] failed to delete loop file:');
    }
  });

  app.post('/api/openchamber/scheduled-tasks/:taskId/run', async (req, res) => {
    const taskID = parseTaskID(req);
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      return res.json({ ok: true, ...await scheduledTaskService.run(taskID) });
    } catch (error) {
      return sendServiceError(res, error, '[ScheduledTasks] failed to run task:');
    }
  });

  app.get('/api/openchamber/scheduled-tasks/status', async (_req, res) => {
    try {
      return res.json(await scheduledTaskService.status());
    } catch (error) {
      console.error('[ScheduledTasks] failed to resolve scheduled task status:', error);
      return res.status(500).json({ error: 'Failed to resolve scheduled task status' });
    }
  });

  app.get('/api/openchamber/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Whether a client can drive a browser view is a property of that client,
    // not of this server: a desktop shell and a browser tab can be connected to
    // the same server at once. Recording it on the connection keeps the answer
    // current without any enable/disable setting to go stale.
    res.openchamberBrowserCapable = req.query?.browser === '1';

    const clients = getOpenChamberEventClients();
    clients.add(res);

    try {
      writeSseEvent(res, {
        type: 'openchamber:event-stream-ready',
        properties: {
          connectedAt: Date.now(),
        },
      });
    } catch {
    }

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'openchamber:heartbeat',
          properties: {
            timestamp: Date.now(),
          },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });
};
