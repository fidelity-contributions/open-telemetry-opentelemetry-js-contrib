/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
  isWrapped,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';
import {
  SEMATTRS_NET_HOST_IP,
  SEMATTRS_NET_HOST_PORT,
  SEMATTRS_NET_PEER_IP,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_NET_PEER_PORT,
  SEMATTRS_NET_TRANSPORT,
  NETTRANSPORTVALUES_IP_TCP,
} from '@opentelemetry/semantic-conventions';
import { TLSAttributes } from './types';
import { NormalizedOptions, SocketEvent } from './internal-types';
import { getNormalizedArgs, IPC_TRANSPORT } from './utils';
/** @knipignore */
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';
import { Socket } from 'net';
import { TLSSocket } from 'tls';
import type * as net from 'net';

export class NetInstrumentation extends InstrumentationBase {
  constructor(config: InstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  init(): InstrumentationNodeModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition(
        'net',
        ['*'],
        (moduleExports: typeof net) => {
          if (isWrapped(moduleExports.Socket.prototype.connect)) {
            this._unwrap(moduleExports.Socket.prototype, 'connect');
          }
          this._wrap(
            moduleExports.Socket.prototype,
            'connect',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._getPatchedConnect() as any
          );
          return moduleExports;
        },
        (moduleExports: typeof net) => {
          if (moduleExports === undefined) return;
          this._unwrap(moduleExports.Socket.prototype, 'connect');
        }
      ),
    ];
  }

  private _getPatchedConnect() {
    return (original: (...args: unknown[]) => void) => {
      const plugin = this;
      return function patchedConnect(this: Socket, ...args: unknown[]) {
        const options = getNormalizedArgs(args);

        const span =
          this instanceof TLSSocket
            ? plugin._startTLSSpan(options, this)
            : plugin._startSpan(options, this);

        return safeExecuteInTheMiddle(
          () => original.apply(this, args),
          error => {
            if (error !== undefined) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error.message,
              });
              span.recordException(error);
              span.end();
            }
          }
        );
      };
    };
  }

  private _startSpan(
    options: NormalizedOptions | undefined | null,
    socket: Socket
  ) {
    if (!options) {
      return this._startGenericSpan(socket);
    }
    if (options.path) {
      return this._startIpcSpan(options, socket);
    }
    return this._startTcpSpan(options, socket);
  }

  private _startTLSSpan(
    options: NormalizedOptions | undefined | null,
    socket: TLSSocket
  ) {
    const tlsSpan = this.tracer.startSpan('tls.connect');

    const netSpan = context.with(
      trace.setSpan(context.active(), tlsSpan),
      () => {
        return this._startSpan(options, socket);
      }
    );

    const otelTlsSpanListener = () => {
      const peerCertificate = socket.getPeerCertificate(true);
      const cipher = socket.getCipher();
      const protocol = socket.getProtocol();
      const attributes = {
        [TLSAttributes.PROTOCOL]: String(protocol),
        [TLSAttributes.AUTHORIZED]: String(socket.authorized),
        [TLSAttributes.CIPHER_NAME]: cipher.name,
        [TLSAttributes.CIPHER_VERSION]: cipher.version,
        [TLSAttributes.CERTIFICATE_FINGERPRINT]: peerCertificate.fingerprint,
        [TLSAttributes.CERTIFICATE_SERIAL_NUMBER]: peerCertificate.serialNumber,
        [TLSAttributes.CERTIFICATE_VALID_FROM]: peerCertificate.valid_from,
        [TLSAttributes.CERTIFICATE_VALID_TO]: peerCertificate.valid_to,
        [TLSAttributes.ALPN_PROTOCOL]: '',
      };
      if (socket.alpnProtocol) {
        attributes[TLSAttributes.ALPN_PROTOCOL] = socket.alpnProtocol;
      }

      tlsSpan.setAttributes(attributes);
      tlsSpan.end();
    };

    const otelTlsErrorListener = (e: Error) => {
      tlsSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: e.message,
      });
      tlsSpan.end();
    };

    /* if we use once and tls.connect() uses a callback this is never executed */
    socket.prependOnceListener(SocketEvent.SECURE_CONNECT, otelTlsSpanListener);
    socket.once(SocketEvent.ERROR, otelTlsErrorListener);

    const otelTlsRemoveListeners = () => {
      socket.removeListener(SocketEvent.SECURE_CONNECT, otelTlsSpanListener);
      socket.removeListener(SocketEvent.ERROR, otelTlsErrorListener);
      for (const event of SOCKET_EVENTS) {
        socket.removeListener(event, otelTlsRemoveListeners);
      }
    };

    for (const event of [
      SocketEvent.CLOSE,
      SocketEvent.ERROR,
      SocketEvent.SECURE_CONNECT,
    ]) {
      socket.once(event, otelTlsRemoveListeners);
    }

    return netSpan;
  }

  /* It might still be useful to pick up errors due to invalid connect arguments. */
  private _startGenericSpan(socket: Socket) {
    const span = this.tracer.startSpan('connect');

    registerListeners(socket, span);

    return span;
  }

  private _startIpcSpan(options: NormalizedOptions, socket: Socket) {
    const span = this.tracer.startSpan('ipc.connect', {
      attributes: {
        [SEMATTRS_NET_TRANSPORT]: IPC_TRANSPORT,
        [SEMATTRS_NET_PEER_NAME]: options.path,
      },
    });

    registerListeners(socket, span);

    return span;
  }

  private _startTcpSpan(options: NormalizedOptions, socket: Socket) {
    const span = this.tracer.startSpan('tcp.connect', {
      attributes: {
        [SEMATTRS_NET_TRANSPORT]: NETTRANSPORTVALUES_IP_TCP,
        [SEMATTRS_NET_PEER_NAME]: options.host,
        [SEMATTRS_NET_PEER_PORT]: options.port,
      },
    });

    registerListeners(socket, span, { hostAttributes: true });

    return span;
  }
}

const SOCKET_EVENTS = [
  SocketEvent.CLOSE,
  SocketEvent.CONNECT,
  SocketEvent.ERROR,
];

function spanEndHandler(span: Span) {
  return () => {
    span.end();
  };
}

function spanErrorHandler(span: Span) {
  return (e: Error) => {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: e.message,
    });
  };
}

function registerListeners(
  socket: Socket,
  span: Span,
  { hostAttributes = false }: { hostAttributes?: boolean } = {}
) {
  const setSpanError = spanErrorHandler(span);
  const setSpanEnd = spanEndHandler(span);

  const setHostAttributes = () => {
    span.setAttributes({
      [SEMATTRS_NET_PEER_IP]: socket.remoteAddress,
      [SEMATTRS_NET_HOST_IP]: socket.localAddress,
      [SEMATTRS_NET_HOST_PORT]: socket.localPort,
    });
  };

  socket.once(SocketEvent.ERROR, setSpanError);

  if (hostAttributes) {
    socket.once(SocketEvent.CONNECT, setHostAttributes);
  }

  const removeListeners = () => {
    socket.removeListener(SocketEvent.ERROR, setSpanError);
    socket.removeListener(SocketEvent.CONNECT, setHostAttributes);
    for (const event of SOCKET_EVENTS) {
      socket.removeListener(event, setSpanEnd);
      socket.removeListener(event, removeListeners);
    }
  };

  for (const event of SOCKET_EVENTS) {
    socket.once(event, setSpanEnd);
    socket.once(event, removeListeners);
  }
}
