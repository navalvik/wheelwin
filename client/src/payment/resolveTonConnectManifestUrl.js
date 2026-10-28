export function resolveTonConnectManifestUrl(origin, localManifestUrl) {
    const page=new URL(origin);
    const host=page.hostname;
    const local=['localhost','127.0.0.1','[::1]'].includes(host)
        || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
        || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
        || /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
    if(local && localManifestUrl) {
        const manifest=new URL(localManifestUrl);
        if(manifest.protocol!=='https:')throw new Error('Local TonConnect manifest requires public HTTPS');
        return manifest.href;
    }
    return new URL('/tonconnect-manifest.json',page).href;
}
