package io.github.maxgreat.writingtool

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var keyboardShown = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge, the window no longer shrinks for the on-screen keyboard,
    // so the page would scroll its top bar away to show the caret. Shrink the
    // content instead, by the keyboard's height (which includes the
    // navigation bar under it): the page then ends just above the keyboard.
    // The page is also told whether the keyboard is shown, since from inside
    // it a keyboard and a smaller window (split screen) look the same.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      view.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
      val shown = insets.isVisible(WindowInsetsCompat.Type.ime())
      if (shown != keyboardShown) {
        keyboardShown = shown
        tellPage()
      }
      insets
    }
    // The side edges are left to the system: with gesture navigation, a swipe
    // from either edge is Back, all along it. The page's own edge swipes (which
    // open the side panels) then only get the edges when Back is a button.
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  /**
   * Sets data-on-screen-keyboard="shown" or "hidden" on the page's root
   * element and fires "onscreenkeyboardchange" on the window (read by
   * src/ui/useOnScreenKeyboard.ts). Sent when the keyboard is shown or
   * hidden. A page that loads with the keyboard already up has no attribute
   * yet, which counts as hidden, until the keyboard next changes.
   */
  private fun tellPage() {
    val state = if (keyboardShown) "shown" else "hidden"
    webView?.evaluateJavascript(
      "document.documentElement.dataset.onScreenKeyboard='$state';" +
        "window.dispatchEvent(new Event('onscreenkeyboardchange'));",
      null,
    )
  }
}
