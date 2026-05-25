import { useCallback, useEffect, useState } from 'react';
import { apiFetcher } from '../utils/fetch';

export default function usePresence(entityType, entityId) {
  const [viewers, setViewers] = useState([]);

  const heartbeat = useCallback(async () => {
    if (!entityType || !entityId) return;
    if (typeof document !== 'undefined' && document.hidden) return;
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
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        heartbeat();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      clearInterval(interval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [heartbeat]);

  return viewers;
}
