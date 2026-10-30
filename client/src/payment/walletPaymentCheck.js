import QRCode from 'qrcode';

// Deliberately separate from authoritative game payment requests: no room,
// no fabricated payment intent, no connection or automatic wallet submission.
if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
    const destination='0QC0LQzn3bmA6fnG6dvIi0HjO18FIdQrbUb_FL-QyT_Bc0ul';
    const memo='WheelWin_QR_025_TEST_20261028';
    const uri=`ton://transfer/${destination}?${new URLSearchParams({amount:'250000000',text:memo})}`;
    document.getElementById('destination').textContent=`Recipient: ${destination}`;
    document.getElementById('memo').textContent=`Memo: ${memo}`;
    document.getElementById('payment-link').href=uri;
    QRCode.toDataURL(uri,{width:360,margin:4,errorCorrectionLevel:'M'}).then(image=>{
        document.getElementById('payment-qr').src=image;
    });
}
