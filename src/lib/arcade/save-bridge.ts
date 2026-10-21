// [GAME-3] Docteur Arcade — host side of the save protocol: one validated request (protocol.ts) → one store
// operation (saves.ts) → one ARCADE_SAVE_RESULT payload. Called only after the host checked event.source, schema,
// gameId, instanceId and requestId, so `request.gameId` is the running game's registry id.
import type { ArcadeSaveRequest, ArcadeSaveResultPayload } from './protocol.ts';
import type { ArcadeSaveStore } from './saves.ts';

export async function answerArcadeSaveRequest(store: ArcadeSaveStore, request: ArcadeSaveRequest): Promise<ArcadeSaveResultPayload> {
  switch (request.type) {
    case 'ARCADE_SAVE_LOAD': {
      const result = await store.load(request.gameId);
      if (!result.ok) return { op: 'LOAD', status: 'ERROR', code: result.code };
      if (result.status === 'EMPTY') return { op: 'LOAD', status: 'EMPTY' };
      const { saveVersion, createdAt, updatedAt, data } = result.save;
      return { op: 'LOAD', status: 'FOUND', save: { saveVersion, createdAt, updatedAt, data } };
    }
    case 'ARCADE_SAVE_WRITE': {
      const result = await store.write(request.gameId, request.payload.saveVersion, request.payload.data);
      if (!result.ok) return { op: 'WRITE', status: 'ERROR', code: result.code };
      const { saveVersion, createdAt, updatedAt } = result.save;
      return { op: 'WRITE', status: 'SAVED', save: { saveVersion, createdAt, updatedAt } };
    }
    case 'ARCADE_SAVE_DELETE': {
      const result = await store.remove(request.gameId);
      return result.ok ? { op: 'DELETE', status: 'DELETED' } : { op: 'DELETE', status: 'ERROR', code: result.code };
    }
  }
}
