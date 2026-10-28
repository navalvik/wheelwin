import { TonConnectUI } from '@tonconnect/ui-react';
import { resolveTonConnectManifestUrl } from './resolveTonConnectManifestUrl.js';

const status=document.getElementById('status');
if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
    document.getElementById('connect').disabled=true;
    status.textContent='Эта страница доступна для локальной проверки.';
} else {
    const ui=new TonConnectUI({manifestUrl:resolveTonConnectManifestUrl(location.origin,import.meta.env.VITE_TONCONNECT_MANIFEST_URL)});
    const show=wallet=>{
        status.textContent=wallet ? `${wallet.account.chain==='-3'?'Подключён Testnet кошелёк':'Подключён кошелёк другой сети'}: ${wallet.account.address}` : 'Кошелёк пока не подключён.';
    };
    ui.onStatusChange(show,error=>{status.textContent=error.message;});
    ui.connectionRestored.then(()=>show(ui.wallet));
    document.getElementById('connect').onclick=()=>ui.openModal().catch(error=>{status.textContent=error.message;});
    document.getElementById('disconnect').onclick=()=>ui.disconnect().catch(error=>{status.textContent=error.message;});
}
