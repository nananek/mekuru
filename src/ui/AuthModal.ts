import { AuthService } from '../services/AuthService';
import { UpdateService } from '../services/UpdateService';
import { Toast } from './Toast';

export class AuthModal {
  private container: HTMLElement;
  private onCloseCallback: () => void;

  constructor(container: HTMLElement, onClose: () => void) {
    this.container = container;
    this.onCloseCallback = onClose;

    this.render();
  }

  private async render(): Promise<void> {
    const user = await AuthService.checkStatus();
    const version = UpdateService.getVersion();

    let accountHtml = '';

    if (user && user.authenticated) {
      accountHtml = `
        <div class="space-y-4">
          <div class="p-4 rounded-xl bg-green-50 border border-green-200 text-green-900 text-sm">
            <div class="font-medium">ログイン中（パスキー有効）</div>
            <div class="text-xs text-green-700 mt-1 font-mono">ユーザー名: ${user.username}</div>
          </div>
          <p class="text-xs text-black/60">
            描画されたクロッキーは自動的にサーバーへ同期され、安全に保管されます。
          </p>
          <div class="flex justify-end gap-2 pt-2">
            <button id="auth-logout-btn" class="px-4 py-2 rounded-lg bg-black/5 hover:bg-black/10 text-xs font-medium text-red-600 transition-colors">
              ログアウト
            </button>
          </div>
        </div>
      `;
    } else {
      accountHtml = `
        <div class="space-y-4">
          <p class="text-xs text-black/60 leading-relaxed">
            パスキー（Touch ID / Face ID / 端末生体認証）でログインすると、スケッチがサーバーに自動バックアップされます。
          </p>

          <div class="space-y-2">
            <label class="block text-xs font-medium text-black/70">ユーザー名（新規登録時のみ必要）</label>
            <input id="auth-username-input" type="text" placeholder="例: croquis_artist" class="w-full px-3 py-2 text-sm rounded-lg border border-black/15 bg-white focus:outline-none focus:border-black font-mono" />
          </div>

          <div class="flex flex-col sm:flex-row gap-2 pt-2">
            <button id="auth-register-btn" class="flex-1 px-4 py-2.5 rounded-lg bg-[#1a1a1a] text-[#fdfbf7] text-xs font-medium shadow-sm active:scale-95 transition-all flex items-center justify-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <line x1="19" x2="19" y1="8" y2="14"/>
                <line x1="22" x2="16" y1="11" y2="11"/>
              </svg>
              <span>パスキーを新規登録</span>
            </button>
            <button id="auth-login-btn" class="flex-1 px-4 py-2.5 rounded-lg border border-black/15 hover:bg-black/5 text-xs font-medium text-[#1a1a1a] active:scale-95 transition-all flex items-center justify-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                <polyline points="10 17 15 12 10 7"/>
                <line x1="15" x2="15" y1="12" y2="3"/>
              </svg>
              <span>パスキーでログイン（入力不要）</span>
            </button>
          </div>

          <div class="p-3 rounded-lg bg-black/5 text-[11px] text-black/50 leading-normal">
            ※パスキー紛失時は、サーバーホスト側CLI (<code>./mekuru reset-passkey &lt;user&gt;</code>) からいつでもリセットできます。
          </div>
        </div>
      `;
    }

    this.container.innerHTML = `
      <div id="auth-backdrop" class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex justify-center items-center p-4">
        <div class="w-full max-w-md bg-[#fdfbf7] rounded-2xl shadow-2xl p-6 border border-black/10">
          <div class="flex items-center justify-between pb-4 border-b border-black/5 mb-4">
            <h2 class="text-base font-semibold tracking-wide text-[#1a1a1a] flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span>設定</span>
            </h2>
            <button id="auth-close-btn" class="p-1.5 rounded-full hover:bg-black/5 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          ${accountHtml}

          <div class="pt-4 mt-4 border-t border-black/5">
            <h3 class="text-xs font-semibold tracking-wide text-black/70 mb-2">アプリの更新</h3>
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] font-mono text-black/50">ビルド: ${version}</span>
              <button id="settings-update-btn" class="px-4 py-2 rounded-lg bg-[#1a1a1a] text-[#fdfbf7] text-xs font-medium shadow-sm active:scale-95 transition-all">
                最新版に更新
              </button>
            </div>
            <p class="text-[11px] text-black/40 leading-normal mt-2">
              Service Worker とキャッシュを破棄して開き直します。描画データ（端末内・サーバー）は消えません。
            </p>
          </div>
        </div>
      </div>
    `;

    this.attachEvents();
  }

  private attachEvents(): void {
    const backdrop = document.getElementById('auth-backdrop');
    const closeBtn = document.getElementById('auth-close-btn');
    const registerBtn = document.getElementById('auth-register-btn') as HTMLButtonElement | null;
    const loginBtn = document.getElementById('auth-login-btn') as HTMLButtonElement | null;
    const logoutBtn = document.getElementById('auth-logout-btn') as HTMLButtonElement | null;
    const usernameInput = document.getElementById('auth-username-input') as HTMLInputElement | null;

    closeBtn?.addEventListener('click', () => this.close());
    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });

    registerBtn?.addEventListener('click', async () => {
      const username = usernameInput?.value.trim();
      if (!username) {
        Toast.show('ユーザー名を入力してください');
        return;
      }
      try {
        Toast.show('Touch ID / Face ID を確認してください...');
        await AuthService.registerPasskey(username);
        Toast.show('パスキーを登録しました！');
        this.render();
      } catch (err) {
        Toast.show((err as Error).message || '登録に失敗しました');
      }
    });

    loginBtn?.addEventListener('click', async () => {
      // Usernameless (discoverable) login: the passkey itself identifies
      // the account, so no username input is needed.
      try {
        Toast.show('生体認証で認証中...');
        await AuthService.loginPasskey();
        Toast.show('ログインに成功しました');
        this.render();
      } catch (err) {
        Toast.show((err as Error).message || 'ログインに失敗しました');
      }
    });

    logoutBtn?.addEventListener('click', async () => {
      await AuthService.logout();
      Toast.show('ログアウトしました');
      this.render();
    });

    const updateBtn = document.getElementById('settings-update-btn') as HTMLButtonElement | null;
    updateBtn?.addEventListener('click', async () => {
      if (confirm('最新版に更新しますか？（開き直します。描画データは消えません）')) {
        Toast.show('更新しています...');
        await UpdateService.forceUpdate();
      }
    });
  }

  public close(): void {
    this.container.innerHTML = '';
    this.onCloseCallback();
  }
}
