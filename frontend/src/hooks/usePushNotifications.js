import { useEffect } from 'react';
import api from '../services/api';

const PUSH_PROMPT_FLAG = 'push_permission_prompted_v1';

function hasPromptedInSession() {
  try {
    return sessionStorage.getItem(PUSH_PROMPT_FLAG) === '1';
  } catch {
    return false;
  }
}

function markPromptedInSession() {
  try {
    sessionStorage.setItem(PUSH_PROMPT_FLAG, '1');
  } catch {
    // Ignore storage errors (private mode / restricted storage)
  }
}

function requestNotificationPermissionCompat() {
  try {
    const requestPermission = Notification.requestPermission.bind(Notification);

    // Modern browsers return a Promise and should be called without a callback.
    if (requestPermission.length === 0) {
      const maybePromise = requestPermission();
      if (maybePromise && typeof maybePromise.then === 'function') {
        return maybePromise;
      }
      return Promise.resolve(Notification.permission);
    }

    // Older Safari supports callback style only.
    return new Promise((resolve) => {
      requestPermission(resolve);
    });
  } catch {
    return Promise.resolve(Notification.permission);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function getVapidPublicKey() {
  // Use env var if available (avoids extra request)
  if (process.env.REACT_APP_VAPID_PUBLIC_KEY) {
    return process.env.REACT_APP_VAPID_PUBLIC_KEY;
  }
  const res = await api.get('/push/vapid-key');
  return res.data.publicKey;
}

async function upsertPushSubscription(isAuthenticated) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { subscribed: false, reason: 'unsupported' };
  }

  if (Notification.permission !== 'granted') {
    return { subscribed: false, reason: 'permission_not_granted' };
  }

  if (!isAuthenticated) {
    return { subscribed: false, reason: 'login_required' };
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await api.post('/push/subscribe', existing.toJSON());
    return { subscribed: true, reason: 'already_subscribed' };
  }

  const vapidKey = await getVapidPublicKey();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });

  await api.post('/push/subscribe', subscription.toJSON());
  return { subscribed: true, reason: 'subscribed' };
}

export function usePushNotifications(isAuthenticated) {
  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    if (Notification.permission === 'granted') {
      upsertPushSubscription(isAuthenticated).catch((err) => {
        console.warn('Push subscription sync error:', err.message);
      });
      return;
    }

    if (Notification.permission === 'denied') {
      return;
    }

    if (!hasPromptedInSession()) {
      let requested = false;
      const removeGestureListeners = () => {
        window.removeEventListener('click', requestFromGesture, true);
        window.removeEventListener('touchstart', requestFromGesture, true);
        window.removeEventListener('keydown', requestFromGesture, true);
        window.removeEventListener('pointerdown', requestFromGesture, true);
        window.removeEventListener('mousedown', requestFromGesture, true);
      };

      const requestFromGesture = () => {
        if (requested) return;
        requested = true;

        requestNotificationPermissionCompat()
          .then((permission) => {
            if (permission === 'granted') {
              markPromptedInSession();
              removeGestureListeners();
              return upsertPushSubscription(isAuthenticated);
            }

            if (permission === 'denied') {
              markPromptedInSession();
              removeGestureListeners();
              return null;
            }

            // Permission is still default (no visible prompt / deferred by browser): allow retry on next gesture.
            requested = false;
            return null;
          })
          .catch((err) => {
            requested = false;
            console.warn('Push permission prompt error:', err.message);
          });
      };

      window.addEventListener('click', requestFromGesture, true);
      window.addEventListener('touchstart', requestFromGesture, true);
      window.addEventListener('keydown', requestFromGesture, true);
      window.addEventListener('pointerdown', requestFromGesture, true);
      window.addEventListener('mousedown', requestFromGesture, true);

      return () => {
        removeGestureListeners();
      };
    }
  }, [isAuthenticated]);
}
