import { useState, useEffect } from 'react';
import { platform } from '@tauri-apps/plugin-os';

export type Platform = 'macos' | 'windows' | 'linux' | 'unknown';

/**
 * Hook to detect the current operating system
 */
export function useOS() {
  const [os, setOS] = useState<Platform>('unknown');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const detectOS = async () => {
      try {
        const detected = await platform();
        // Platform returns: 'linux', 'macos', 'ios', 'freebsd', 'dragonfly', 'netbsd', 'openbsd', 'solaris', 'android', 'windows'
        if (detected === 'macos' || detected === 'ios') {
          setOS('macos');
        } else if (detected === 'windows') {
          setOS('windows');
        } else if (detected === 'linux' || detected === 'freebsd') {
          setOS('linux');
        } else {
          setOS('unknown');
        }
      } catch {
        // Fallback to navigator detection
        const userAgent = navigator.userAgent.toLowerCase();
        if (userAgent.includes('mac')) {
          setOS('macos');
        } else if (userAgent.includes('win')) {
          setOS('windows');
        } else if (userAgent.includes('linux')) {
          setOS('linux');
        }
      } finally {
        setLoading(false);
      }
    };

    detectOS();
  }, []);

  return { os, isMac: os === 'macos', isWindows: os === 'windows', isLinux: os === 'linux', loading };
}
