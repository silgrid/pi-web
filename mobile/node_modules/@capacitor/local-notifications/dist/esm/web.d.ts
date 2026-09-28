import { WebPlugin } from '@capacitor/core';
import type { PermissionState } from '@capacitor/core';
import type { DeliveredNotifications, EnabledResult, ListChannelsResult, LocalNotificationSchema, LocalNotificationsPlugin, PendingResult, PermissionStatus, ScheduleOptions, ScheduleResult, SettingsPermissionStatus } from './definitions';
export declare class LocalNotificationsWeb extends WebPlugin implements LocalNotificationsPlugin {
    protected pending: LocalNotificationSchema[];
    protected deliveredNotifications: Notification[];
    getDeliveredNotifications(): Promise<DeliveredNotifications>;
    removeDeliveredNotifications(delivered: DeliveredNotifications): Promise<void>;
    removeAllDeliveredNotifications(): Promise<void>;
    createChannel(): Promise<void>;
    deleteChannel(): Promise<void>;
    listChannels(): Promise<ListChannelsResult>;
    schedule(options: ScheduleOptions): Promise<ScheduleResult>;
    getPending(): Promise<PendingResult>;
    registerActionTypes(): Promise<void>;
    cancel(pending: ScheduleResult): Promise<void>;
    areEnabled(): Promise<EnabledResult>;
    changeExactNotificationSetting(): Promise<SettingsPermissionStatus>;
    checkExactNotificationSetting(): Promise<SettingsPermissionStatus>;
    requestPermissions(): Promise<PermissionStatus>;
    checkPermissions(): Promise<PermissionStatus>;
    protected hasNotificationSupport: () => boolean;
    protected transformNotificationPermission(permission: NotificationPermission): PermissionState;
    protected sendPending(): void;
    protected sendNotification(notification: LocalNotificationSchema): void;
    protected buildNotification(notification: LocalNotificationSchema): Notification;
    protected onClick(notification: LocalNotificationSchema): void;
    protected onShow(notification: LocalNotificationSchema): void;
}
