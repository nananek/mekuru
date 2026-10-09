/**
 * AuthService
 * Handles WebAuthn (Passkey) registration, authentication, and session state.
 */

export interface UserSession {
  userId: string;
  username: string;
  authenticated: boolean;
}

export class AuthService {
  private static API_BASE = '/api/auth';
  private static currentUser: UserSession | null = null;

  public static getCurrentUser(): UserSession | null {
    return this.currentUser;
  }

  /**
   * Checks current login status with the server
   */
  public static async checkStatus(): Promise<UserSession | null> {
    try {
      const res = await fetch(`${this.API_BASE}/me`);
      if (res.ok) {
        const data = await res.json();
        this.currentUser = {
          userId: data.user_id,
          username: data.username,
          authenticated: true,
        };
        return this.currentUser;
      }
    } catch {
      // Server offline / not reachable
    }
    this.currentUser = null;
    return null;
  }

  /**
   * Registers a new passkey for a username
   */
  public static async registerPasskey(username: string): Promise<boolean> {
    if (!window.PublicKeyCredential) {
      throw new Error('この端末・ブラウザはパスキー（WebAuthn）に対応していません。');
    }

    // 1. Get creation challenge options from server
    const startRes = await fetch(`${this.API_BASE}/register-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      throw new Error(err.message || 'パスキー登録リクエストに失敗しました');
    }

    const { challenge_id, options } = await startRes.json();

    // Convert base64url challenge and user id to ArrayBuffer
    options.publicKey.challenge = this.base64UrlToBuffer(options.publicKey.challenge);
    options.publicKey.user.id = this.base64UrlToBuffer(options.publicKey.user.id);
    if (options.publicKey.excludeCredentials) {
      options.publicKey.excludeCredentials = options.publicKey.excludeCredentials.map((cred: { id: string }) => ({
        ...cred,
        id: this.base64UrlToBuffer(cred.id),
      }));
    }

    // 2. Prompt Touch ID / Face ID / Passkey creation
    const credential = (await navigator.credentials.create({
      publicKey: options.publicKey,
    })) as PublicKeyCredential;

    if (!credential) {
      throw new Error('パスキー作成がキャンセルされました');
    }

    const rawResponse = credential.response as AuthenticatorAttestationResponse;
    const finishPayload = {
      challenge_id,
      id: credential.id,
      rawId: this.bufferToBase64Url(credential.rawId),
      response: {
        clientDataJSON: this.bufferToBase64Url(rawResponse.clientDataJSON),
        attestationObject: this.bufferToBase64Url(rawResponse.attestationObject),
      },
      type: credential.type,
    };

    // 3. Complete registration on server
    const finishRes = await fetch(`${this.API_BASE}/register-finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finishPayload),
    });

    if (!finishRes.ok) {
      const err = await finishRes.json().catch(() => ({}));
      throw new Error(err.message || 'パスキー登録完了処理に失敗しました');
    }

    const finishData = await finishRes.json();
    this.currentUser = {
      userId: finishData.user_id,
      username: finishData.username,
      authenticated: true,
    };

    return true;
  }

  /**
   * Logs in using an existing passkey
   */
  public static async loginPasskey(username?: string): Promise<boolean> {
    if (!window.PublicKeyCredential) {
      throw new Error('この端末・ブラウザはパスキー（WebAuthn）に対応していません。');
    }

    // 1. Get authentication challenge
    const startRes = await fetch(`${this.API_BASE}/login-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      throw new Error(err.message || 'ログインリクエストに失敗しました');
    }

    const { challenge_id, options } = await startRes.json();
    options.publicKey.challenge = this.base64UrlToBuffer(options.publicKey.challenge);
    if (options.publicKey.allowCredentials) {
      options.publicKey.allowCredentials = options.publicKey.allowCredentials.map((cred: { id: string }) => ({
        ...cred,
        id: this.base64UrlToBuffer(cred.id),
      }));
    }

    // 2. Prompt Face ID / Touch ID / Passkey
    const assertion = (await navigator.credentials.get({
      publicKey: options.publicKey,
    })) as PublicKeyCredential;

    if (!assertion) {
      throw new Error('パスキー認証がキャンセルされました');
    }

    const rawResponse = assertion.response as AuthenticatorAssertionResponse;
    const finishPayload = {
      challenge_id,
      id: assertion.id,
      rawId: this.bufferToBase64Url(assertion.rawId),
      response: {
        clientDataJSON: this.bufferToBase64Url(rawResponse.clientDataJSON),
        authenticatorData: this.bufferToBase64Url(rawResponse.authenticatorData),
        signature: this.bufferToBase64Url(rawResponse.signature),
        userHandle: rawResponse.userHandle ? this.bufferToBase64Url(rawResponse.userHandle) : null,
      },
      type: assertion.type,
    };

    // 3. Complete authentication
    const finishRes = await fetch(`${this.API_BASE}/login-finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finishPayload),
    });

    if (!finishRes.ok) {
      const err = await finishRes.json().catch(() => ({}));
      throw new Error(err.message || 'パスキー認証に失敗しました');
    }

    const finishData = await finishRes.json();
    this.currentUser = {
      userId: finishData.user_id,
      username: finishData.username,
      authenticated: true,
    };

    return true;
  }

  public static async logout(): Promise<void> {
    try {
      await fetch(`${this.API_BASE}/logout`, { method: 'POST' });
    } catch {
      // ignore
    }
    this.currentUser = null;
  }

  // Helper converters
  private static bufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private static base64UrlToBuffer(base64Url: string): ArrayBuffer {
    let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
