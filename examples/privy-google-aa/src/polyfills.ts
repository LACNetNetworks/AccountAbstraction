import { Buffer } from "buffer";

const globals = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

if (!globals.Buffer) {
  globals.Buffer = Buffer;
}
