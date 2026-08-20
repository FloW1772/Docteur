import { Hono } from 'hono';
import { getTodoItems, addTodoItem, updateTodoItem, deleteTodoItem } from '../lib/sqlite.js';

export function createTodoRoute() {
  const route = new Hono();

  // GET /api/todo — list all todo items
  route.get('/todo', (c) => {
    try {
      return c.json({ items: getTodoItems() });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/todo — create a new todo item
  route.post('/todo', async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      if (!body?.id || !body?.type) {
        return c.json({ error: 'Champs requis: id, type' }, 400);
      }
      if (!['capture', 'task'].includes(body.type)) {
        return c.json({ error: 'type doit être capture ou task' }, 400);
      }
      // Validate URL protocol if provided
      if (body.url) {
        try {
          const parsed = new URL(body.url);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return c.json({ error: 'URL invalide — protocole http/https requis' }, 400);
          }
        } catch {
          return c.json({ error: 'URL invalide' }, 400);
        }
      }
      addTodoItem(body);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // PATCH /api/todo/:id — update status/fields
  route.patch('/todo/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const body = await c.req.json().catch(() => null);
      if (!body) return c.json({ error: 'Body manquant' }, 400);
      updateTodoItem(id, body);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // DELETE /api/todo/:id — remove a todo item
  route.delete('/todo/:id', (c) => {
    try {
      const id = c.req.param('id');
      deleteTodoItem(id);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  return route;
}
