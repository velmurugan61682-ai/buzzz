package com.buzz.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.buzz.app.data.repository.AuthRepository
import com.buzz.app.data.repository.MissedCallRepository
import com.buzz.app.ui.screens.DashboardScreen
import com.buzz.app.ui.screens.LoginScreen
import com.buzz.app.ui.screens.PermissionScreen
import com.buzz.app.ui.theme.BuzzzTheme

class MainActivity : ComponentActivity() {

    private lateinit var authRepository: AuthRepository
    private lateinit var missedCallRepository: MissedCallRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        authRepository = AuthRepository(applicationContext)
        missedCallRepository = MissedCallRepository(applicationContext)

        setContent {
            BuzzzTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    AppNavigation(
                        authRepo = authRepository,
                        missedCallRepo = missedCallRepository,
                        hasPermissions = { checkRequiredPermissions() }
                    )
                }
            }
        }
    }

    private fun checkRequiredPermissions(): Boolean {
        val permissions = arrayOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_CONTACTS
        )
        return permissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }
}

@Composable
private fun AppNavigation(
    authRepo: AuthRepository,
    missedCallRepo: MissedCallRepository,
    hasPermissions: () -> Boolean
) {
    var isLoggedIn by remember { mutableStateOf(authRepo.isLoggedIn()) }
    var permissionsGranted by remember { mutableStateOf(hasPermissions()) }

    when {
        !isLoggedIn -> {
            LoginScreen(
                authRepo = authRepo,
                onLoginSuccess = {
                    isLoggedIn = true
                }
            )
        }
        !permissionsGranted -> {
            PermissionScreen(
                onPermissionsGranted = {
                    permissionsGranted = true
                }
            )
        }
        else -> {
            DashboardScreen(
                authRepo = authRepo,
                missedCallRepo = missedCallRepo,
                onLogout = {
                    authRepo.logout()
                    isLoggedIn = false
                }
            )
        }
    }
}
