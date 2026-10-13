'use client';
import { useOffline } from 'next/offline';

export default function OfflineBadge() {
  const offline = useOffline();
  return <p data-testid="conn">{offline ? 'offline' : 'online'}</p>;
}
