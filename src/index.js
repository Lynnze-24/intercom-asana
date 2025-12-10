import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Asana configuration
const ASANA_TOKEN =
  '2/1212353370344534/1212340334177314:423f18d3f0b9a38f0e75513a31350873';
const ASANA_WORKSPACE = '1211014974336131';
const ASANA_PROJECT = '1212353369442239';

// Asana Custom Field GIDs - You need to get these from your Asana project
// To get custom field GIDs, go to: https://app.asana.com/api/1.0/projects/{ASANA_PROJECT}/custom_field_settings
const ASANA_CUSTOM_FIELDS = {
  WALLET: null, // Replace with actual GID
  PAYMENT_GATEWAY: null, // Replace with actual GID
  TRANSACTION_ID: null, // Replace with actual GID
  AMOUNT: null, // Replace with actual GID
  AGENT_REMARK: null, // Replace with actual GID
};

// Intercom configuration
const INTERCOM_TOKEN =
  'dG9rOmQxMmIxYTQxXzcwMDhfNGE2Ml9iODU1XzQ5MjFkNjA4NWRlZDoxOjA=';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

/*
  This object defines the canvas that will display when your app initializes.
  It includes a button to create an Asana task for the contact.
  
  More information on these can be found in the reference docs.
  Canvas docs: https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/
  Components docs: https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/
*/
const initialCanvas = {
  canvas: {
    content: {
      components: [
        {
          type: 'text',
          id: 'header',
          text: 'Create Asana Task for Contact',
          align: 'center',
          style: 'header',
        },
        {
          type: 'button',
          label: 'Create Asana Task',
          style: 'primary',
          id: 'submit_button',
          action: {
            type: 'submit',
          },
        },
      ],
    },
  },
};

// Helper function to get contact name from Intercom API
async function getContactName(contactId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/contacts/${contactId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.name || 'Unknown Contact';
    }
    return 'Unknown Contact';
  } catch (error) {
    console.error('Error fetching contact from Intercom:', error);
    return 'Unknown Contact';
  }
}

// Helper function to get conversation details from Intercom API
async function getConversation(conversationId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching conversation from Intercom:', error);
    return null;
  }
}

// Helper function to update Intercom conversation custom attributes
async function updateConversationAttribute(conversationId, asanaTaskId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          custom_attributes: {
            AsanaTaskID: asanaTaskId,
          },
        }),
      }
    );

    if (response.ok) {
      console.log('Successfully updated conversation with Asana task ID');
      return true;
    } else {
      const errorData = await response.json();
      console.error('Error updating conversation:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating conversation attribute:', error);
    return false;
  }
}

// Helper function to get custom field settings for a project
async function getAsanaCustomFields() {
  try {
    const response = await fetch(
      `https://app.asana.com/api/1.0/projects/${ASANA_PROJECT}/custom_field_settings`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      console.log('Custom field settings:', JSON.stringify(data, null, 2));
      return data.data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    return null;
  }
}

// Helper function to validate if string is a valid URL
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// Helper function to upload attachment to Asana task
async function uploadAttachmentToAsana(taskId, attachmentUrl) {
  try {
    // Validate if it's a proper URL
    if (!isValidUrl(attachmentUrl)) {
      console.error('Invalid attachment URL:', attachmentUrl);
      console.log(
        'The attachment field appears to be an ID or invalid URL. Please provide a full URL.'
      );
      return null;
    }

    // Download the file from the attachment URL
    console.log('Downloading attachment from:', attachmentUrl);
    const fileResponse = await fetch(attachmentUrl);

    if (!fileResponse.ok) {
      console.error(
        'Failed to download attachment. Status:',
        fileResponse.status
      );
      return null;
    }

    // Get the file buffer and content type
    const fileBuffer = await fileResponse.buffer();
    const contentType =
      fileResponse.headers.get('content-type') || 'application/octet-stream';

    // Extract filename from URL or use a default
    const urlParts = attachmentUrl.split('/');
    const fileName =
      urlParts[urlParts.length - 1].split('?')[0] || 'attachment';

    // Create form data for multipart upload
    const formData = new FormData();
    formData.append('parent', taskId);
    formData.append('file', fileBuffer, {
      filename: fileName,
      contentType: contentType,
    });

    // Upload to Asana
    console.log('Uploading attachment to Asana task:', taskId);
    const asanaResponse = await fetch(
      'https://app.asana.com/api/1.0/attachments',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    if (asanaResponse.ok) {
      const asanaData = await asanaResponse.json();
      console.log('Successfully uploaded attachment to Asana');
      return asanaData.data.permanent_url || asanaData.data.download_url;
    } else {
      const errorData = await asanaResponse.json();
      console.error('Error uploading attachment to Asana:', errorData);
      return null;
    }
  } catch (error) {
    console.error('Error in uploadAttachmentToAsana:', error);
    return null;
  }
}

// Root route - serves the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper endpoint to get custom field GIDs
app.get('/asana-custom-fields', async (req, res) => {
  try {
    const customFieldSettings = await getAsanaCustomFields();

    if (customFieldSettings) {
      const fields = customFieldSettings.map((setting) => ({
        name: setting.custom_field.name,
        gid: setting.custom_field.gid,
        type: setting.custom_field.resource_type,
        description: setting.custom_field.description,
      }));

      res.json({
        success: true,
        project_id: ASANA_PROJECT,
        custom_fields: fields,
        message:
          'Copy these GIDs to the ASANA_CUSTOM_FIELDS object in index.js',
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to fetch custom fields from Asana',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/*
  This is an endpoint that Intercom will POST HTTP request when a teammate inserts 
  the app into the inbox, or a new conversation is viewed.
*/
app.post('/initialize', async (req, res) => {
  console.log('Initialize endpoint hit');
  console.log('Initialize request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const asanaTaskId = conversation?.custom_attributes?.AsanaTaskID;

    if (asanaTaskId) {
      // Conversation already has an Asana task, show completed state
      const completedCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'success',
                text: '✓ Asana Task Already Created',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'task_id',
                text: `Task ID: ${asanaTaskId}`,
                align: 'center',
                style: 'paragraph',
              },
              {
                type: 'text',
                id: 'info',
                text: 'This conversation already has an Asana task associated with it.',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      return res.send(completedCanvas);
    }
  }

  // No existing task, show create button
  res.send(initialCanvas);
});

/*
  When a submit action is taken in a canvas component, it will hit this endpoint.
  This endpoint creates an Asana task with the contact's name and prevents
  duplicate submissions per conversation.
*/
app.post('/submit', async (req, res) => {
  console.log('Submit endpoint hit with component_id:', req.body.component_id);
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const existingTaskId = conversation?.custom_attributes?.AsanaTaskID;

    if (existingTaskId) {
      const alreadySubmittedCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'already_submitted',
                text: 'Task already created for this conversation',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'task_id',
                text: `Task ID: ${existingTaskId}`,
                align: 'center',
                style: 'paragraph',
              },
              {
                type: 'text',
                id: 'info',
                text: 'You can only create one Asana task per conversation.',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      return res.send(alreadySubmittedCanvas);
    }
  }

  if (req.body.component_id === 'submit_button') {
    try {
      // Extract contact name from Intercom data
      let contactName =
        req.body.contact?.name || req.body.customer?.name || null;

      // If no name in request body, fetch from Intercom API
      if (!contactName) {
        const contactId = req.body.contact?.id || req.body.customer?.id;
        if (contactId) {
          contactName = await getContactName(contactId);
        } else {
          contactName = 'Unknown Contact';
        }
      }

      // Get full conversation details to access custom attributes
      const fullConversation = await getConversation(conversationId);
      const customAttrs = fullConversation?.custom_attributes || {};

      // Extract the 6 custom fields
      const attachmentUrl = customAttrs.attachment || null;
      const wallet = customAttrs.Wallet || '';
      const paymentGateway = customAttrs['Payment Gateway'] || '';
      const transactionID = customAttrs['Transaction ID'] || '';
      const amount = customAttrs.Amount || '';
      const agentRemark = customAttrs['Agent Remark'] || '';

      // Build basic task notes
      const taskNotes = `Task created from Intercom conversation ${conversationId}

Contact Information:
- Name: ${contactName}
- Email: ${req.body.contact?.email || req.body.customer?.email || 'N/A'}`;

      // Build custom fields object for Asana
      const customFields = {};

      if (ASANA_CUSTOM_FIELDS.WALLET && wallet) {
        customFields[ASANA_CUSTOM_FIELDS.WALLET] = wallet;
      }
      if (ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY && paymentGateway) {
        customFields[ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY] = paymentGateway;
      }
      if (ASANA_CUSTOM_FIELDS.TRANSACTION_ID && transactionID) {
        customFields[ASANA_CUSTOM_FIELDS.TRANSACTION_ID] = transactionID;
      }
      if (ASANA_CUSTOM_FIELDS.AMOUNT && amount) {
        customFields[ASANA_CUSTOM_FIELDS.AMOUNT] = amount;
      }
      if (ASANA_CUSTOM_FIELDS.AGENT_REMARK && agentRemark) {
        customFields[ASANA_CUSTOM_FIELDS.AGENT_REMARK] = agentRemark;
      }

      // Create task payload
      const taskPayload = {
        workspace: ASANA_WORKSPACE,
        projects: [ASANA_PROJECT],
        name: contactName,
        notes: taskNotes,
      };

      // Only add custom_fields if we have any configured
      if (Object.keys(customFields).length > 0) {
        taskPayload.custom_fields = customFields;
      }

      console.log(
        'Creating Asana task with payload:',
        JSON.stringify(taskPayload, null, 2)
      );

      // Create Asana task
      const asanaResponse = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: taskPayload,
        }),
      });

      const asanaData = await asanaResponse.json();

      if (asanaResponse.ok) {
        const asanaTaskId = asanaData.data.gid;

        // Upload attachment to Asana if available
        let attachmentPermanentUrl = null;
        let attachmentStatus = null;
        if (attachmentUrl && attachmentUrl !== 'N/A') {
          console.log('Processing attachment:', attachmentUrl);

          // Check if it's a valid URL before attempting upload
          if (!isValidUrl(attachmentUrl)) {
            console.log('Attachment field is not a valid URL, skipping upload');
            attachmentStatus = 'invalid_url';
          } else {
            attachmentPermanentUrl = await uploadAttachmentToAsana(
              asanaTaskId,
              attachmentUrl
            );

            if (attachmentPermanentUrl) {
              console.log(
                'Attachment uploaded successfully:',
                attachmentPermanentUrl
              );
              attachmentStatus = 'success';
            } else {
              attachmentStatus = 'failed';
            }
          }
        }

        // Save Asana task ID to Intercom conversation
        await updateConversationAttribute(conversationId, asanaTaskId);

        const components = [
          {
            type: 'text',
            id: 'success',
            text: '✓ Asana Task Created',
            align: 'center',
            style: 'header',
          },
          {
            type: 'text',
            id: 'task_name',
            text: `Task: ${contactName}`,
            align: 'center',
            style: 'paragraph',
          },
          {
            type: 'text',
            id: 'task_id',
            text: `Task ID: ${asanaTaskId}`,
            align: 'center',
            style: 'paragraph',
          },
        ];

        // Add attachment status if attachment was processed
        if (attachmentUrl && attachmentStatus) {
          let statusText = '';
          if (attachmentStatus === 'success') {
            statusText = '✓ Attachment uploaded successfully';
          } else if (attachmentStatus === 'invalid_url') {
            statusText =
              '⚠ Attachment field is not a valid URL (ID: ' +
              attachmentUrl +
              ')';
          } else {
            statusText = '⚠ Attachment upload failed';
          }

          components.push({
            type: 'text',
            id: 'attachment_status',
            text: statusText,
            align: 'center',
            style: 'paragraph',
          });
        }

        const syncedFieldsText =
          Object.keys(customFields).length > 0
            ? `✓ Synced ${
                Object.keys(customFields).length
              } custom fields to Asana`
            : '⚠ Configure ASANA_CUSTOM_FIELDS to sync custom fields';

        components.push({
          type: 'text',
          id: 'synced_fields',
          text: syncedFieldsText,
          align: 'center',
          style: 'paragraph',
        });

        const successCanvas = {
          canvas: {
            content: {
              components: components,
            },
          },
        };
        res.send(successCanvas);
      } else {
        throw new Error(
          asanaData.errors?.[0]?.message || 'Failed to create Asana task'
        );
      }
    } catch (error) {
      console.error('Error creating Asana task:', error);

      const errorCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'error',
                text: 'Error Creating Task',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'error_message',
                text: error.message || 'An unexpected error occurred',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      res.send(errorCanvas);
    }
  } else {
    res.send(initialCanvas);
  }
});

const listener = app.listen(PORT, () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
});
