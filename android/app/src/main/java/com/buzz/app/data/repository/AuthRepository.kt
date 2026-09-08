package com.buzz.app.data.repository

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import com.buzz.app.data.api.ApiClient
import com.buzz.app.data.model.LoginRequest
import com.buzz.app.data.model.LoginResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AuthRepository(private val context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    companion object {
        private const val PREFS_NAME = "buzzz_auth_prefs"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_BASE_URL = "server_base_url"
        private const val DEFAULT_BASE_URL = "http://10.0.2.2:5000/"
    }

    fun getDeviceId(): String {
        return try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "device_unknown"
        } catch (e: Exception) {
            "device_fallback_${System.currentTimeMillis()}"
        }
    }

    fun saveAuthToken(token: String, email: String) {
        prefs.edit()
            .putString(KEY_AUTH_TOKEN, token)
            .putString(KEY_USER_EMAIL, email)
            .apply()
    }

    fun getAuthToken(): String? {
        return prefs.getString(KEY_AUTH_TOKEN, null)
    }

    fun getUserEmail(): String? {
        return prefs.getString(KEY_USER_EMAIL, null)
    }

    fun isLoggedIn(): Boolean {
        return !getAuthToken().isNullOrBlank()
    }

    fun logout() {
        prefs.edit().clear().apply()
    }

    fun setServerBaseUrl(url: String) {
        var cleanUrl = url.trim()
        if (!cleanUrl.endsWith("/")) cleanUrl += "/"
        prefs.edit().putString(KEY_BASE_URL, cleanUrl).apply()
    }

    fun getServerBaseUrl(): String {
        return prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
    }

    suspend fun login(email: String, password: String? = null): Result<LoginResponse> = withContext(Dispatchers.IO) {
        try {
            val service = ApiClient.getService(context)
            val response = service.login(LoginRequest(email = email, password = password))
            if (response.isSuccessful && response.body() != null) {
                val body = response.body()!!
                if (body.ok && !body.token.isNullOrEmpty()) {
                    saveAuthToken(body.token, email)
                }
                Result.success(body)
            } else {
                Result.failure(Exception("Login failed with HTTP status ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
