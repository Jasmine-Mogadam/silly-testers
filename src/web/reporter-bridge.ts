import { Reporter } from '../core/reporter';
import type { Finding } from '../core/types';
import { WebBridge } from './web-bridge';

/**
 * Subclass of Reporter that additionally notifies the WebBridge when a
 * finding is written to disk, so the web UI can display it in real-time.
 */
export class ReporterBridge extends Reporter {
  write(finding: Finding): string {
    const filePath = super.write(finding);
    WebBridge.getInstanceIfExists()?.reportFiled(finding, filePath);
    return filePath;
  }
}
