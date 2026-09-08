package com.buzz.app.data.model

import com.google.gson.annotations.SerializedName

/**
 * Payload sent from Android companion app to BUZZZ backend POST /api/calls/missed
 */
data class MissedCallEvent(
    @SerializedName("phoneNumber")
    val phoneNumber: String,

    @SerializedName("contactName")
    val contactName: String = "Unknown Caller",

    @SerializedName("email")
    val email: String? = null,

    @SerializedName("callType")
    val callType: String = "MISSED",

    @SerializedName("calledAt")
    val calledAt: String,

    @SerializedName("deviceId")
    val deviceId: String,

    @SerializedName("externalCallId")
    val externalCallId: String
)

data class SyncResponse(
    @SerializedName("success")
    val success: Boolean,

    @SerializedName("message")
    val message: String? = null,

    @SerializedName("duplicate")
    val duplicate: Boolean = false,

    @SerializedName("id")
    val id: String? = null
)

data class LoginRequest(
    @SerializedName("email")
    val email: String,

    @SerializedName("password")
    val password: String? = null
)

data class LoginResponse(
    @SerializedName("ok")
    val ok: Boolean,

    @SerializedName("token")
    val token: String? = null,

    @SerializedName("message")
    val message: String? = null
)
