package com.buzz.app.data.api

import android.content.Context
import com.buzz.app.data.repository.AuthRepository
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {
    private var retrofit: Retrofit? = null
    private var currentBaseUrl: String = "http://10.0.2.2:5000/"

    fun getService(context: Context): BuzzzApiService {
        val authRepo = AuthRepository(context)
        val baseUrl = authRepo.getServerBaseUrl()

        if (retrofit == null || currentBaseUrl != baseUrl) {
            currentBaseUrl = baseUrl
            val targetUrl = if (currentBaseUrl.endsWith("/")) currentBaseUrl else "$currentBaseUrl/"

            val authInterceptor = Interceptor { chain ->
                val original = chain.request()
                val builder = original.newBuilder()

                val token = authRepo.getAuthToken()
                if (!token.isNullOrEmpty()) {
                    builder.header("Authorization", "Bearer $token")
                    builder.header("x-session-token", token)
                }

                chain.proceed(builder.build())
            }

            val logging = HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BODY
            }

            val okHttpClient = OkHttpClient.Builder()
                .addInterceptor(authInterceptor)
                .addInterceptor(logging)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .build()

            retrofit = Retrofit.Builder()
                .baseUrl(targetUrl)
                .client(okHttpClient)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
        }

        return retrofit!!.create(BuzzzApiService::class.java)
    }
}
