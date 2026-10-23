import { File, Paths } from 'expo-file-system';
import { useEffect } from 'react';

import { request } from '@/miniapps/server/api';
import { loadConnection } from '@/miniapps/server/connection';

/**
 * In a release build an uncaught JS error aborts the app, and iOS's crash report doesn't say what
 * the error was. Write it down before the abort, and send it to the status server's journal on
 * the next launch. Render errors don't come through here: React hands them straight to
 * ExceptionsManager, so the root layout's ErrorBoundary catches those and calls sendCrashReport.
 */
const report = new File(Paths.document, 'last-crash.txt');

export function describeError(error: unknown) {
  const e = error instanceof Error ? error : new Error(String(error));
  return `${new Date().toISOString()} ${e.name}: ${e.message}\n${e.stack ?? ''}`;
}

export function installCrashRecorder() {
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal) {
      try {
        report.writeSync(describeError(error));
      } catch {}
    }
    previous(error, isFatal);
  });
}

export async function sendCrashReport(text: string) {
  const conn = await loadConnection();
  if (!conn) throw new Error('No server connection');
  await request(conn, '/api/crash', { method: 'POST', body: JSON.stringify({ report: text }) });
}

export function useCrashReports() {
  useEffect(() => {
    if (!report.exists) return;
    let text: string;
    try {
      text = report.textSync();
    } catch {
      return;
    }
    sendCrashReport(text).then(
      () => {
        try {
          report.delete();
        } catch {
          // Gone already; nothing to send again.
        }
      },
      () => {
        // Server unreachable; keep the report for the next launch.
      },
    );
  }, []);
}
