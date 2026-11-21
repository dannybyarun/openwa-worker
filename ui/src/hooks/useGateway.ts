import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Config, type Message, type SessionStatus } from '../lib/api';

/** Public auth state: whether this worker needs a password and whether we hold a session. */
export function useAuth(config: Config) {
  return useQuery({
    queryKey: ['auth', config.base, config.token],
    queryFn: () => api.auth(config),
    retry: 0,
    staleTime: 15_000,
  });
}

export function useSessions(config: Config, enabled = true) {
  return useQuery({
    queryKey: ['sessions', config.base, config.token],
    queryFn: () => api.sessions(config),
    enabled,
    refetchInterval: 5000,
    retry: 1,
  });
}

export function useStatus(config: Config, sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['status', config.base, config.token, sessionId],
    queryFn: () => api.status(config, sessionId as string),
    enabled: Boolean(sessionId) && enabled,
    refetchInterval: 5000,
    retry: 1,
  });
}

export function useHistory(config: Config, sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['history', config.base, config.token, sessionId],
    queryFn: () => api.history(config, sessionId as string),
    enabled: Boolean(sessionId) && enabled,
    refetchInterval: 20000,
    retry: 1,
  });
}

/** Live event stream for the selected session; writes straight into the query cache. */
export function useEvents(config: Config, sessionId: string | null, enabled = true) {
  const queryClient = useQueryClient();
  const attempt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    let socket: WebSocket | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      try {
        socket = new WebSocket(api.eventsUrl(config, sessionId));
      } catch {
        schedule();
        return;
      }

      socket.onopen = () => {
        attempt.current = 0;
      };

      socket.onmessage = event => {
        let frame: { type?: string; data?: unknown };
        try {
          frame = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (frame.type === 'connection.update') {
          const next = frame.data as SessionStatus;
          queryClient.setQueryData<SessionStatus>(
            ['status', config.base, config.token, sessionId],
            previous => ({ ...previous, ...next, id: next.id ?? sessionId }),
          );
          queryClient.invalidateQueries({ queryKey: ['sessions', config.base, config.token] });
        }
        if (frame.type === 'message') {
          const message = frame.data as Message;
          queryClient.setQueryData<{ id: string; messages: Message[] }>(
            ['history', config.base, config.token, sessionId],
            previous => {
              if (!previous) return previous;
              if (message.id && previous.messages.some(m => m.id === message.id)) return previous;
              return { ...previous, messages: [...previous.messages, message] };
            },
          );
        }
      };

      socket.onclose = () => {
        socket = null;
        schedule();
      };
      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          /* ignore */
        }
      };
    };

    const schedule = () => {
      if (closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt.current);
      attempt.current += 1;
      timer.current = window.setTimeout(connect, delay);
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(timer.current);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    };
  }, [config.base, config.token, sessionId, enabled, queryClient]);
}
