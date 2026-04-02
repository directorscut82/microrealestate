import { useCallback, useEffect, useState } from 'react';
import { apiFetcher } from '../utils/fetch';

export default function usePresence(entityType, entityId) {
  const [viewers, setViewers] = useState([]);

  const heartbeat = useCallback(async () => {
    if (!entityType || !entityId) return;
    try {
      const { data } = await apiFetcher().post(`/presence/${entityType}/${entityId}`);
      setViewers(data);
    } catch (e) {
      // ignore
    }
  }, [entityType, entityId]);

  useEffect(() => {
    heartbeat();
    const interval = setInterval(heartbeat, 30000);
    return () => clearInterval(interval);
  }, [heartbeat]);

  return viewers;
}
