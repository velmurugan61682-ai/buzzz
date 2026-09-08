package com.buzz.app.data.api

import com.buzz.app.data.model.LoginRequest
import com.buzz.app.data.model.LoginResponse
import com.buzz.app.data.model.MissedCallEvent
import com.buzz.app.data.model.SyncResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

interface BuzzzApiService {

    @POST("api/auth/login")
    suspend fun login(
        @Body request: LoginRequest
    ): Response<LoginResponse>

    @POST("api/calls/missed")
    suspend fun syncMissedCall(
        @Body event: MissedCallEvent
    ): Response<SyncResponse>

    @GET("api/calls/missed")
    suspend fun getMissedCalls(
        @Query("limit") limit: Int = 20,
        @Query("page") page: Int = 1
    ): Response<Map<String, Any>>
}
