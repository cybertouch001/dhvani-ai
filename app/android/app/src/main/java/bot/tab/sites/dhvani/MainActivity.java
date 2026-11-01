package bot.tab.sites.dhvani;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Dhvani AI: a thin native shell around https://dhvani.sites.tab.bot (mic, file upload, MP3 download + share). */
public class MainActivity extends Activity {
    private static final String APP_URL = BuildConfig.APP_URL;
    private static final String HOST = Uri.parse(APP_URL).getHost();
    private static final int REQ_MIC = 11, REQ_FILE = 12, REQ_STORAGE = 13;

    private WebView web;
    private PermissionRequest pendingPerm;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingDlUrl, pendingDlName;
    private boolean showingOffline = false;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        createWebView();
        if (saved != null) web.restoreState(saved); else web.loadUrl(APP_URL);
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(0xFF0F0C24);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " DhvaniAndroid/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "DhvaniNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, ua, cd, mime, len) -> download(url, URLUtil.guessFileName(url, cd, "audio/mpeg")));
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    public void onBackPressed() {
        if (web.canGoBack() && !showingOffline) web.goBack(); else super.onBackPressed();
    }

    private void loadOffline() {
        showingOffline = true;
        web.loadUrl("file:///android_asset/offline.html");
    }

    /* ---------------- web clients ---------------- */
    private class Client extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if ("file".equals(u.getScheme())) return false;
            if (HOST.equals(u.getHost())) { showingOffline = false; return false; }
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { /* ignore */ }
            return true;
        }
        @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame() && !"file".equals(r.getUrl().getScheme())) loadOffline();
        }
        // The page's renderer can be killed (low memory) or crash: rebuild the WebView instead of letting the app die.
        @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
            if (v != web) return true;
            android.view.ViewGroup parent = (android.view.ViewGroup) v.getParent();
            if (parent != null) parent.removeView(v);
            v.destroy();
            createWebView();
            web.loadUrl(APP_URL);
            return true;
        }
        @Override public void onPageStarted(WebView v, String url, Bitmap f) {
            if (url.startsWith("file:")) return;
            showingOffline = false;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override public void onPermissionRequest(PermissionRequest req) {
            runOnUiThread(() -> {
                boolean wantsAudio = false;
                for (String r : req.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsAudio = true;
                if (!wantsAudio || !HOST.equals(req.getOrigin().getHost())) { req.deny(); return; }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingPerm = req;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            });
        }
        @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("audio/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "application/ogg", "video/mp4", "video/webm"});
            try { startActivityForResult(Intent.createChooser(i, "Audio file chuno"), REQ_FILE); }
            catch (ActivityNotFoundException e) { fileCallback = null; toast("File chooser nahi mila"); return false; }
            return true;
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQ_FILE && fileCallback != null) {
            Uri[] res = null;
            if (result == RESULT_OK && data != null && data.getData() != null) res = new Uri[]{data.getData()};
            fileCallback.onReceiveValue(res);
            fileCallback = null;
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] grants) {
        boolean ok = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_MIC && pendingPerm != null) {
            if (ok) pendingPerm.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else { pendingPerm.deny(); toast("Mic permission ke bina recording nahi hogi — audio file choose kar sakte ho"); }
            pendingPerm = null;
        } else if (code == REQ_STORAGE) {
            if (ok && pendingDlUrl != null) download(pendingDlUrl, pendingDlName);
            else toast("Storage permission nahi mili");
            pendingDlUrl = null;
        }
    }

    /* ---------------- download + share ---------------- */
    private void download(String url, String name) {
        if (!url.startsWith("https://")) { toast("Download nahi ho sakta"); return; }
        if (name == null || name.isEmpty() || !name.endsWith(".mp3")) name = "dhvani-" + (System.currentTimeMillis() / 1000) + ".mp3";
        if (Build.VERSION.SDK_INT <= 28 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDlUrl = url; pendingDlName = name;
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            return;
        }
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setTitle(name);
            r.setDescription("Dhvani AI");
            r.setMimeType("audio/mpeg");
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
            toast("Download shuru — Downloads folder mein milega");
        } catch (Exception e) {
            toast("Download fail: " + e.getMessage());
        }
    }

    private void share(String url, String name) {
        if (!url.startsWith("https://")) return;
        final String fname = (name == null || !name.endsWith(".mp3")) ? "dhvani.mp3" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        toast("Share ke liye taiyaar ho raha hai…");
        new Thread(() -> {
            try {
                File dir = new File(getCacheDir(), "share");
                dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 3600_000L) f.delete();
                File out = new File(dir, fname);
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(20000); c.setReadTimeout(60000);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) os.write(b, 0, n);
                }
                Uri uri = FileProvider.getUriForFile(this, "bot.tab.sites.dhvani.files", out);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("audio/mpeg");
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, "Share Dhvani audio");
                runOnUiThread(() -> startActivity(chooser));
            } catch (Exception e) {
                runOnUiThread(() -> toast("Share fail: " + e.getMessage()));
            }
        }).start();
    }

    private void toast(String m) { new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(this, m, Toast.LENGTH_LONG).show()); }

    /** window.DhvaniNative in the page */
    private class Bridge {
        @JavascriptInterface public void share(String url, String name) { MainActivity.this.share(url, name); }
        @JavascriptInterface public void download(String url, String name) { runOnUiThread(() -> MainActivity.this.download(url, name)); }
        @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }
        @JavascriptInterface public void retry() { runOnUiThread(() -> { showingOffline = false; web.loadUrl(APP_URL); }); }
    }
}
