import type { Duplex } from "node:stream";
import { GrpcClient, type GrpcClientOptions } from "./grpc.ts";
import {
  decodeReadFileResponse,
  decodeResolveImageConfigResponse,
  decodeSolveResponse,
  encodeReadFileRequest,
  encodeResolveImageConfigRequest,
  encodeReturnRequest,
  encodeSolveRequest,
  encodeWarnRequest,
  encodeEmpty,
  type ReadFileRequest,
  type ResolveImageConfigRequest,
  type ResolveImageConfigResponse,
  type Result,
  type ReturnRequest,
  type SolveRequest,
  type SolveResponse,
  type WarnRequest,
} from "./messages.ts";

const SERVICE = "/moby.buildkit.v1.frontend.LLBBridge/";

/** Typed client for the gateway API a frontend calls back into. */
export class GatewayClient {
  private readonly grpc: GrpcClient;

  constructor(stream: Duplex, opts: GrpcClientOptions = {}) {
    this.grpc = new GrpcClient(stream, opts);
  }

  async ping(): Promise<void> {
    await this.grpc.call(SERVICE + "Ping", encodeEmpty());
  }

  async solve(req: SolveRequest): Promise<SolveResponse> {
    const res = await this.grpc.call(SERVICE + "Solve", encodeSolveRequest(req));
    return decodeSolveResponse(res);
  }

  async readFile(req: ReadFileRequest): Promise<Uint8Array> {
    const res = await this.grpc.call(SERVICE + "ReadFile", encodeReadFileRequest(req));
    return decodeReadFileResponse(res);
  }

  async resolveImageConfig(req: ResolveImageConfigRequest): Promise<ResolveImageConfigResponse> {
    const res = await this.grpc.call(
      SERVICE + "ResolveImageConfig",
      encodeResolveImageConfigRequest(req),
    );
    return decodeResolveImageConfigResponse(res);
  }

  async return_(req: ReturnRequest): Promise<void> {
    await this.grpc.call(SERVICE + "Return", encodeReturnRequest(req));
  }

  /** Best-effort; older daemons do not implement Warn. */
  async warn(req: WarnRequest): Promise<void> {
    try {
      await this.grpc.call(SERVICE + "Warn", encodeWarnRequest(req));
    } catch {
      // A missing Warn capability must not fail the build.
    }
  }

  close(): void {
    this.grpc.close();
  }
}

export type { Result, SolveResponse, ReturnRequest };
